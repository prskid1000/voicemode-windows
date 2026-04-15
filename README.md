# VoxType

Local voice dictation overlay for Windows. Press a hotkey, speak, release — text appears at your cursor in any app. Fully self-hosted: no cloud, no telemetry, no account.

A local-first alternative to [Wispr Flow](https://wisprflow.ai), [Superwhisper](https://superwhisper.com), and [Aqua Voice](https://aquavoice.com). Runs entirely on your machine using [faster-whisper-server](https://github.com/fedirz/faster-whisper-server) for speech-to-text, optional [LM Studio](https://lmstudio.ai) for transcript cleanup, and optional [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) for TTS.

VoxType is a single Electron app that **owns the lifecycle of all bundled services**. They spawn when VoxType starts and die when it quits. One scheduled task. One tray icon. One process tree. No `.bat`/`.vbs` wrappers, no separate Windows services to manage.

---

## Table of contents

- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [How it works](#how-it-works)
- [The pipeline, step by step](#the-pipeline-step-by-step)
- [Tray menu reference](#tray-menu-reference)
- [Whisper models](#whisper-models)
- [LLM enhancement (LM Studio)](#llm-enhancement-lm-studio)
- [Screen context (vision)](#screen-context-vision)
- [Kokoro TTS (optional)](#kokoro-tts-optional)
- [Hotkey rebinding](#hotkey-rebinding)
- [Files and storage](#files-and-storage)
- [Logs and debugging](#logs-and-debugging)
- [Performance and VRAM](#performance-and-vram)
- [Privacy model](#privacy-model)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Comparison vs cloud alternatives](#comparison-vs-cloud-alternatives)
- [Known limitations](#known-limitations)
- [Credits](#credits)

---

## Quick start

```powershell
git clone https://github.com/prskid1000/voicemode-windows.git "$env:USERPROFILE\.voicemode-windows"
cd "$env:USERPROFILE\.voicemode-windows"
.\setup.ps1
```

The script will:

1. Verify Python 3.10+, Node.js 18+, git, ffmpeg, and (optionally) NVIDIA GPU
2. Create `stt-venv/` and `pip install faster-whisper-server` (~390 MB)
3. Clone Kokoro-FastAPI, create `tts-venv/`, install PyTorch + CUDA wheels (~5 GB), download Kokoro v1.0 model (~313 MB) — skip with `-SkipKokoro` if you don't need TTS
4. Build the VoxType Electron app in place
5. Register a single scheduled task `VoxType-Dictation` that auto-starts at logon
6. Start VoxType immediately

Look for the tray icon (bottom-right). Press **Ctrl+Win**, speak, release.

**Setup is idempotent.** Re-running `setup.ps1` skips git clone, venv creation, and model download if those artifacts exist. `pip install` always runs but exits in seconds when nothing needs downloading. A re-run on a fully-installed machine takes ~30–60 s.

### Setup options

```powershell
.\setup.ps1                                           # full install
.\setup.ps1 -SkipKokoro                               # no TTS — saves ~5 GB
.\setup.ps1 -GpuSupport $false                        # CPU-only PyTorch
.\setup.ps1 -WhisperModel "Systran/faster-whisper-medium"
.\setup.ps1 -InstallDir "D:\voxtype"                  # custom location
```

---

## Prerequisites

| Dependency | Required for | Where to get it |
|---|---|---|
| **Windows 10/11** | Target OS | — |
| **Python 3.10+** | Whisper + Kokoro venvs (3.12 recommended) | https://python.org |
| **Node.js 18+** | Build the Electron app | https://nodejs.org |
| **git** | Clone Kokoro-FastAPI | https://git-scm.com |
| **ffmpeg** (optional) | Some audio codecs Whisper might receive | https://ffmpeg.org or `winget install ffmpeg` |
| **NVIDIA GPU + CUDA driver** | Strongly recommended for Kokoro; Whisper works on CPU | https://nvidia.com/drivers |
| **LM Studio** (optional) | LLM transcript cleanup | https://lmstudio.ai |

LM Studio is *the* missing piece for the magic — without it, you get raw Whisper transcripts (which are fine for casual notes but include filler words, no punctuation cleanup, and no contextual fixes). With LM Studio running on `localhost:1234` with a 3B–8B model loaded, dictation feels Wispr-grade.

---

## How it works

```
                       Scheduled Task: VoxType-Dictation
                                       │
                                       ▼
                             electron.exe → VoxType
                             │              │              │
                             ▼              ▼              ▼
                       spawns child    spawns child    HTTP client
                       ┌──────────┐   ┌──────────┐   ┌──────────┐
                       │ Whisper  │   │  Kokoro  │   │ LM Studio│
                       │   :6600  │   │   :6500  │   │  :1234   │
                       │ (always) │   │ (opt-in) │   │ (external)│
                       └──────────┘   └──────────┘   └──────────┘
```

VoxType is the **parent process**. It launches Whisper (always, by default) and Kokoro (off by default — toggle from tray) as child processes, healthchecks them via HTTP, restarts them on crash with exponential backoff, and kills them cleanly when you quit. LM Studio is the only piece VoxType doesn't manage — it's a separate user app that needs to be running with a model loaded.

This single-parent architecture means:

- **One thing to start, one thing to stop.** Quit VoxType → all bundled services die. No orphans.
- **No `.bat`/`.vbs` shims.** The scheduled task launches `electron.exe` directly. No console window pops up.
- **No separate scheduled tasks.** Previous versions had three (Whisper-STT, Kokoro-TTS, VoxType-Dictation); now just `VoxType-Dictation`.
- **Service health is observable.** The tray menu shows live status badges (`● ready` / `… starting` / `○ off`).

---

## The pipeline, step by step

1. **Hotkey down** → `START_RECORDING` IPC to renderer; pill expands and shows live waveform
2. **Renderer** records from a pre-warmed mic stream (no cold-start delay) and monitors RMS energy for auto-stop
3. **Hotkey up** (or 2 s of silence in toggle mode) → audio Buffer sent back via `AUDIO_DATA` IPC
4. **VAD gate** drops empty/silent recordings before they even hit Whisper (saves ~500 ms per false trigger)
5. **Screen capture** kicks off in parallel with transcription — captures the display under the cursor and paints a red marker at the OS cursor position
6. **Whisper STT** transcribes the audio (~0.5–1 s for 3 s of audio on a small model)
7. **LM Studio** (optional) receives transcript + screenshot + JSON-schema response format. Returns `{screen_context, cursor_focus, edit_plan, output}` — only `output` is shown
8. **Type at cursor** via clipboard → `Ctrl+V` (works in every Windows app, including ones that block synthetic keystrokes)
9. **Session record** appended to `~/.voxtype/sessions.jsonl` for debugging

End-to-end latency for a 3 s dictation:
- Without LLM: ~700 ms (Whisper Small on RTX GPU)
- With LLM cleanup (text-only, 3B model): ~1.5 s
- With LLM cleanup + screen context (7B vision model): ~2.5–4 s

---

## Tray menu reference

```
VoxType
├─ ◉ Hold to talk                    Record while hotkey is held; release to send
├─ ◉ Toggle on/off                   First press starts, second stops
├─ Hotkey: Ctrl+Win                  Click to rebind (single key or two-key combo)
├─ Services
│   ├─ Whisper (STT) — ● ready       Status badge updates every 5 s
│   │   ├─ ☑ Enabled                 Master switch — toggling restarts service
│   │   ├─ ── Model ──
│   │   ├─ ◉ Tiny / Base / Small / Medium / Large v3
│   │   ├─ ── Device ──
│   │   ├─ ◉ GPU / CPU
│   │   └─ Restart now               Kill + respawn current Whisper child
│   ├─ Kokoro (TTS) — ○ off
│   │   ├─ ☐ Enabled                 OFF by default (nothing in VoxType uses TTS)
│   │   ├─ ── Voice ──               15 curated English voices (60+ available)
│   │   ├─ ◉ Sky / Heart / Bella / …
│   │   ├─ ── Device ──
│   │   ├─ ◉ GPU / CPU
│   │   └─ Restart now
│   └─ LM Studio (LLM)
│       ├─ ☑ Enhance transcript      Send Whisper output through LLM cleanup
│       ├─ ☑ Screen context (vision) Attach screenshot for deictic resolution
│       ├─ ── Model ──               Auto-detected from LM Studio's loaded models
│       ├─ ◉ (your loaded models, with state badges)
│       ├─ Auto-unload after         Off / 5 / 10 / 15 / 30 / 60 min idle
│       ├─ ☑ Preload on startup      Send dummy request at launch to warm model
│       └─ Refresh models            Re-fetch list from LM Studio
├─ Recording
│   ├─ ☑ Auto-stop on silence        Stop after 2 s of continuous silence
│   ├─ ☑ Skip silence (VAD)          Drop empty audio before sending to Whisper
│   └─ ☐ Append mode                 Preserve clipboard (default replaces selection)
├─ History
│   ├─ ☑ Save history                Last 20 dictations stored persistently
│   └─ Recent                        Last 10 entries — click to copy enhanced text
├─ Pill
│   ├─ Show / Hide pill              Hide the floating overlay (hotkey still works)
│   └─ Reset position                Snap pill back to bottom-center of primary display
└─ Quit                              Stops all child services and exits
```

Status badges live-poll the service manager and refresh every 5 seconds.

---

## Whisper models

| Model | Speed (3 s audio, RTX GPU) | Accuracy | VRAM | Disk |
|---|---|---|---|---|
| Tiny | ~150 ms | Basic, English-only fine | ~1 GB | 75 MB |
| Base | ~200 ms | Good | ~1 GB | 145 MB |
| **Small (default)** | ~400 ms | Great — best speed/quality balance | ~2 GB | 470 MB |
| Medium | ~700 ms | Better | ~5 GB | 1.5 GB |
| Large v3 | ~1 s | Best, multilingual | ~10 GB | 3.1 GB |

Model files download to `~/.cache/huggingface/hub/` on **first use** of each model (not at install time). Switching models from the tray restarts the Whisper child process; the new model downloads on the first dictation after the switch (you'll see a delay).

Models survive uninstalls of `~/.voicemode-windows/` — they live in the global Hugging Face cache and are reused if you reinstall.

---

## LLM enhancement (LM Studio)

VoxType uses [LM Studio](https://lmstudio.ai)'s OpenAI-compatible API for transcript cleanup. Setup:

1. Install LM Studio from https://lmstudio.ai
2. Download a model (any chat model works; vision models add screen context)
3. Open LM Studio → Local Server tab → click **Start Server**
4. Verify: VoxType tray will pick the loaded model up automatically

**Recommended models** (in order of escalating capability + latency):

| Model | Size | Speed | Quality |
|---|---|---|---|
| Qwen2.5 1.5B Instruct | ~1 GB | Fastest | Acceptable for filler removal + punctuation |
| Llama 3.2 3B Instruct | ~2 GB | Fast | Good for general cleanup |
| Qwen2.5 7B Instruct | ~5 GB | Medium | Excellent — recommended sweet spot |
| **Qwen2.5-VL 7B** | ~5 GB | Medium | Same + handles screen context |
| Llama 3.2 Vision 11B | ~7 GB | Slower | Top-tier vision LLM, uses more VRAM |

VoxType auto-selects the smallest model by parameter count if no preference is saved. Switch via tray > Services > LM Studio > Model.

### What the cleanup does

The system prompt (in [`voxtype/resources/system-prompt.md`](voxtype/resources/system-prompt.md), hot-reloaded — edit freely without rebuilding) instructs the model to:

- Remove filler words (`um`, `uh`, `like`, `you know`) when they're not meaningful
- Collapse stutters (`I I want` → `I want`)
- Apply self-corrections (`go to the park no the mall` → `go to the mall`)
- Convert spoken numbers, currency, dates, times to digits/symbols
- Apply spoken punctuation commands (`comma`, `period`, `new paragraph`)
- Preserve technical casing (`React`, `useEffect`, `kubectl`, `PostgreSQL`)
- Preserve mixed-language content without translation
- **Never** answer questions in the transcript (just clean the text)

The model returns a JSON object with grammar-constrained schema:

```json
{
  "screen_context": "≤200 chars — what app/UI is visible (scratch)",
  "cursor_focus":   "≤150 chars — what's at the red cursor marker (scratch)",
  "edit_plan":      "≤300 chars — terse bullets of edits applied (scratch)",
  "output":         "the cleaned transcript (only field shown to you)"
}
```

The scratch fields force the model to reason before writing the final output. Their `maxLength` bounds prevent the model from blathering and stealing tokens from the transcript itself. Scratch values are logged to `debug.log` for debugging.

### Customizing the prompt

Edit `voxtype/resources/system-prompt.md`. The file is read fresh on every enhance call — no rebuild needed. Restart not required.

---

## Screen context (vision)

When **Screen context (vision)** is enabled and a vision-capable model is loaded in LM Studio, VoxType captures the display under your cursor at the moment you finish speaking, paints a **red ring + dot** at the cursor position (Electron's `desktopCapturer` strips the OS cursor on Windows, so we draw it ourselves), and attaches the JPEG to the LLM request as an `image_url` data URL.

Why this matters:

- **Casing of identifiers.** Say "rename this to use effect" while pointing at `useEffect` in VS Code → cleaned text uses correct casing.
- **Disambiguation.** Say "send it to alex" with Slack open showing `@alex.cohen` → uses the right Alex.
- **Homophones.** "their / there", "to / too" — if the screen makes the meaning unambiguous.
- **Deictic resolution.** "this PR", "that error", "the red one" — the model knows what's nearest the cursor.

What it explicitly **does not** do:

- Expand `this` into the identifier under your cursor (your sentence stays as you spoke it)
- Describe the screenshot in the output
- Answer questions visible on screen
- Override what you clearly said

Capture happens in parallel with Whisper transcription so it adds zero latency to that step. The added LLM latency depends on the vision model — typically 1–3 s on a 7B VLM.

Disable from tray > Services > LM Studio > Screen context if you want text-only cleanup or are using a non-vision model.

---

## Kokoro TTS (optional)

Kokoro is **off by default** because nothing in VoxType currently consumes TTS. The toggle is provided for users who want a local OpenAI-compatible TTS endpoint (`http://127.0.0.1:6500/v1/audio/speech`) for other applications.

Enable from tray > Services > Kokoro > Enabled. Voice picker selects from 15 curated English voices (the underlying Kokoro v1.0 model ships 60+ voices across 8 languages, but the menu is curated to keep it usable).

When enabled, Kokoro adds:
- ~5 GB disk (PyTorch CUDA wheels + Kokoro model)
- ~2 GB VRAM when loaded (released by auto-unload)
- ~10 s startup delay (first request triggers CUDA initialization)

If you don't see yourself using TTS from external apps, leave it off and save the resources.

---

## Hotkey rebinding

Default: **Ctrl+Win**. Rebind via tray > `Hotkey: Ctrl+Win`:

1. Click the menu item — capture mode arms
2. **Release every key** on your keyboard (capture waits for a fully-released keyboard so menu accelerator keys don't leak in)
3. Press your desired binding:
   - **Single key**: `F9`, `F10`, `Caps Lock`, etc. — useful for foot-pedal-style triggers
   - **Two keys together**: `Ctrl + Space`, `Win + V`, etc.
4. Release

The new binding persists in `~/.voxtype/settings.json` and is restored on every launch.

**Caveat about toggle mode + auto-repeat:** Windows fires `keydown` repeatedly while a key is held. VoxType's hotkey listener suppresses these auto-repeats so toggle mode doesn't flip on/off when you hold the key past the OS auto-repeat delay (~500 ms). This is a recent fix — older builds had a flicker bug.

---

## Files and storage

```
~/.voicemode-windows/                # repo + install (same dir if cloned here)
├── stt-venv/                        # 390 MB — Whisper venv
├── tts-venv/                        # 5.6 GB — Kokoro PyTorch venv (only if Kokoro installed)
├── Kokoro-FastAPI/                  # 320 MB — Kokoro repo + 313 MB model
└── voxtype/                         # Electron app (built in place)

~/.voxtype/                          # User data — survives reinstalls
├── settings.json                    # All tray settings
├── history.json                     # Last 20 dictations (raw + enhanced) — shown in tray
├── debug.log                        # Main process stdout/stderr
└── sessions.jsonl                   # One JSON per dictation (timings, errors, etc.)

~/.cache/huggingface/hub/            # Whisper models — global, shared with other tools
└── models--Systran--faster-whisper-*/
```

Total disk for a full install: **~6.5 GB** (1.5 GB without Kokoro). Whisper models add 75 MB – 3 GB each on first use.

---

## Logs and debugging

| File | Purpose | Lifecycle |
|---|---|---|
| `~/.voxtype/debug.log` | All `console.log` / `console.error` from main process, including Whisper + Kokoro child output | **Truncated on every launch** |
| `~/.voxtype/sessions.jsonl` | One JSON per dictation: timings, audio KB, screenshot flag + size, model used, raw transcript, enhanced output, error if any | **Truncated on every launch** |
| `~/.voxtype/history.json` | User-visible last-20 history | Persistent |

Tail logs while debugging:

```powershell
Get-Content -Path "$env:USERPROFILE\.voxtype\debug.log" -Wait -Tail 50
```

Sessions JSONL is one record per line — quick `jq`-style analysis:

```powershell
Get-Content "$env:USERPROFILE\.voxtype\sessions.jsonl" | ForEach-Object {
    $j = $_ | ConvertFrom-Json
    "{0,5}ms  {1,4}ms  {2}" -f $j.totalMs, $j.llmMs, $j.enhanced.Substring(0, [Math]::Min(60, $j.enhanced.Length))
}
```

LLM scratch fields appear in `debug.log` so you can see what the model was thinking:

```
[VoxType] LLM scratch — screen: VS Code, React file open | cursor: inside `useEffect` import | plan: case: useeffect→useEffect
```

---

## Performance and VRAM

Approximate VRAM usage with everything running:

| Stack | VRAM |
|---|---|
| Whisper Small (loaded) | ~2 GB |
| Whisper Large v3 (loaded) | ~10 GB |
| Kokoro (loaded) | ~2 GB |
| LM Studio 3B model | ~2 GB |
| LM Studio 7B model | ~5 GB |
| LM Studio 7B vision | ~6 GB |
| **Typical: Whisper Small + 7B LLM** | **~7 GB** |
| **Maximum: Large v3 + Kokoro + 11B vision** | **~19 GB** |

**Auto-unload** (tray > LM Studio > Auto-unload after) frees VRAM after a configurable idle period:
- Unloads the LM Studio model via API
- Restarts the Whisper child (kills the loaded model; reloads on next request)
- Restarts the Kokoro child if enabled

After unload, the next dictation re-loads the model — adds 2–10 s for the first dictation, then back to normal.

---

## Privacy model

| Data | Where it goes |
|---|---|
| Microphone audio | `localhost:6600` (Whisper child process) → discarded after transcription |
| Transcripts | `localhost:1234` (LM Studio) if enhancement enabled, else stays in VoxType |
| Screenshots | `localhost:1234` (LM Studio) if Screen context enabled, else not captured |
| Settings | `~/.voxtype/settings.json` — local file |
| History | `~/.voxtype/history.json` — local file, last 20 entries |
| Debug logs | `~/.voxtype/debug.log` and `sessions.jsonl` — local files, truncated each launch |

**No network calls leave your machine.** No telemetry. No analytics. No account.

The only outbound connections happen during *install*: pip downloads from PyPI, git clones from GitHub, and Hugging Face model downloads on first model use.

---

## Troubleshooting

### VoxType won't start

```powershell
schtasks /query /tn VoxType-Dictation
```

If task missing → re-run `setup.ps1`. If task present but app not running:

```powershell
schtasks /run /tn VoxType-Dictation
Start-Process "$env:USERPROFILE\.voxtype\debug.log"
```

### Hotkey doesn't trigger anything

- Check tray icon appears (bottom-right). If not, app didn't start.
- Try a different hotkey via tray > Hotkey (some keys may conflict with other apps)
- Verify mic permission: Windows Settings > Privacy > Microphone > allow desktop apps

### "Service did not become ready"

A child service (Whisper or Kokoro) failed its 60 s healthcheck. Check `debug.log` for the underlying error. Most common causes:

- Port already in use (another app on 6600 / 6500). Change ports via `~/.voxtype/settings.json`.
- CUDA mismatch — driver is older than the bundled CUDA 12.9 wheels. Update NVIDIA driver.
- Model file corrupted — delete `~/.cache/huggingface/hub/models--Systran--faster-whisper-*/` and let it re-download.

### LLM cleanup doesn't trigger

```powershell
curl http://127.0.0.1:1234/v1/models
```

If error → LM Studio isn't running or server isn't started. Open LM Studio → Local Server → Start Server.

If empty model list → load a model in LM Studio first (Chat tab → select model).

### Transcript is too aggressive / rewords my words

The system prompt explicitly tells the model to preserve your words, but small models (under 3B) sometimes rephrase. Either:
- Switch to a larger model in LM Studio
- Disable enhancement entirely (tray > Services > LM Studio > Enhance transcript)
- Edit `voxtype/resources/system-prompt.md` to be more strict

### First words get cut off

Should be fixed by mic pre-warming (`getUserMedia` called once at app start). If still happening, check that the Electron app has microphone permission in Windows Settings > Privacy > Microphone > Desktop apps.

### Pill is invisible / wrong position

```
Tray > Pill > Reset position
```

If still not visible, transparent windows can fail on some Windows builds with broken graphics drivers. Update GPU driver. As a workaround, you can disable transparency by editing `voxtype/src/main/index.ts` (remove `transparent: true` from the BrowserWindow options) and rebuilding.

### Conch lock from old voice-mode MCP install

If you ever installed the old voice-mode MCP and the conch lock file is stuck:

```powershell
Remove-Item "$env:USERPROFILE\.voicemode\conch" -ErrorAction SilentlyContinue
```

VoxType doesn't use this; cleanup is harmless.

---

## Uninstall

```powershell
.\uninstall.ps1
```

Stops the scheduled task, kills any orphaned `electron`/`faster-whisper-server`/`uvicorn` processes, optionally removes:

- `~/.voxtype/` (settings, history, logs)
- `~/.voicemode/` (legacy directory from old MCP era — present only if you previously installed voice-mode)
- `~/.voicemode-windows/` (the install directory itself, ~6.5 GB)

Each deletion is prompted individually so you can keep what you want.

Whisper models in `~/.cache/huggingface/hub/` are **not** removed (they're a global cache shared with other Hugging Face tools).

---

## Comparison vs cloud alternatives

| Feature | VoxType | Wispr Flow | Superwhisper |
|---|---|---|---|
| Cost | Free / OSS | $15/mo Pro | $8.49/mo Pro |
| Cloud calls | None | All audio + screen | None (local) |
| Platform | Windows only | Mac/Win/iOS/Android | Mac/iOS only |
| Hotkey-to-text | ✓ | ✓ | ✓ |
| LLM cleanup | ✓ (any LM Studio model) | ✓ (proprietary fine-tuned Llama) | ✓ (modes per workflow) |
| Screen context | ✓ (cursor marker) | ✓ (proprietary, opaque) | — |
| Voice commands | — | ✓ | ✓ |
| Personal dictionary | — | ✓ (auto-learns) | ✓ |
| Snippets / triggers | — | ✓ | ✓ |
| App-aware tone | — | ✓ | ✓ (modes) |
| Wake word | — | ✓ ("Hey Flow") | — |
| Sync across devices | — | ✓ | ✓ (iCloud) |
| Whisper Mode (quiet speech) | — | ✓ | — |
| Privacy | Local-only | Cloud, fine-tuning | Local |
| Open source | ✓ MIT | — | — |

VoxType's pitch: **local-first, transparent, free, Windows-native**. The feature gaps vs Wispr Flow are real (no app-context awareness yet, no snippets, no wake word, Windows-only), but the privacy story and zero recurring cost are the main draws.

---

## Known limitations

- **Vision models add latency.** Screen-context cleanup adds 1–3 s on a 7B vision model. Disable in tray > Services > LM Studio > Screen context for snappier text-only cleanup.
- **First Whisper run is slow.** New model downloads on first request after a model switch — minutes for Large v3.
- **No app-context detection yet.** Wispr Flow's killer feature (per-app tone — Slack casual, Gmail formal) requires Windows UI Automation. Not implemented.
- **No snippets / personal dictionary.** Manual abbreviation expansion isn't supported.
- **No wake word.** Hotkey only.
- **Windows only.** uiohook keycodes, taskkill, transparent-window flags, and the build/install scripts are all Windows-specific. Linux/macOS support is not planned.
- **English-tuned prompt.** The cleanup prompt's filler/correction word lists are English (with some Hindi terms for self-corrections). Other languages still work — just less aggressive cleanup.
- **No live transcription.** Audio is sent to Whisper after you stop speaking, not streamed mid-utterance.

---

## Credits

- [faster-whisper-server](https://github.com/fedirz/faster-whisper-server) by fedirz — Whisper STT backbone
- [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) by remsky — TTS backbone
- [Kokoro v1.0](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad — the underlying TTS model
- [LM Studio](https://lmstudio.ai) — local LLM runtime
- [uiohook-napi](https://github.com/SnosMe/uiohook-napi) — global hotkey capture
- [Electron](https://electronjs.org), [React](https://react.dev), [Tailwind](https://tailwindcss.com), [Vite](https://vitejs.dev)
- [Wispr Flow](https://wisprflow.ai) — the inspiration

## License

MIT
