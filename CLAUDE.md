# VoxType — Project Guide for Contributors

This document is the engineering reference. For user-facing docs see [README.md](README.md).

## Project goal

VoxType is a single Electron app that provides Wispr-Flow-style voice dictation on Windows entirely from local services. Hold a hotkey, speak, release — text appears at the cursor in any app. The app **owns the lifecycle of all bundled services** (Whisper STT, optionally Kokoro TTS) so there's exactly one process tree to manage. LM Studio is the only external dependency, and it's optional (without it, you get raw Whisper transcripts).

The previous architecture had three scheduled tasks (`VoiceMode-Whisper-STT`, `VoiceMode-Kokoro-TTS`, `VoxType-Dictation`), patched a third-party `voice-mode` MCP package for Claude Code voice chat, and used `.bat`/`.vbs` shims to launch each service. All of that has been removed. Reference to "voice-mode" anywhere in the code or docs is a leftover from that era and should be excised.

## Project structure

```
voicemode-windows/                  # repo IS the install directory
├── setup.ps1                       # Idempotent installer
├── uninstall.ps1                   # Reverse of setup
├── README.md                       # User-facing docs
├── CLAUDE.md                       # This file
├── LICENSE                         # MIT
├── .gitignore
└── voxtype/                        # Electron app
    ├── package.json
    ├── electron-builder.json       # Used for packaging (not yet active)
    ├── tsconfig.json               # Renderer TS config
    ├── tsconfig.node.json          # Main process TS config
    ├── vite.config.ts              # Renderer build
    ├── resources/
    │   ├── icon.png                # Tray icon (16×16 source)
    │   ├── icon.svg                # Vector source
    │   ├── gen_icon.py             # Icon regeneration helper
    │   └── system-prompt.md        # LLM cleanup prompt — hot-reloaded
    ├── src/
    │   ├── main/                   # Node.js main process
    │   │   ├── index.ts            # App entry, IPC, pipeline orchestration
    │   │   ├── services.ts         # Child process manager (Whisper + Kokoro)
    │   │   ├── debug-log.ts        # Tees console + writes sessions.jsonl; truncates on launch
    │   │   ├── hotkey.ts           # uiohook-napi: global hotkeys, capture mode, auto-repeat suppression
    │   │   ├── stt.ts              # POST audio to Whisper child
    │   │   ├── llm.ts              # POST transcript (+ screenshot) to LM Studio with JSON schema
    │   │   ├── kokoro-voice.ts     # Voice catalog + preload helper (no longer writes voicemode.env)
    │   │   ├── whisper-model.ts    # Model catalog (selection lives in AppSettings)
    │   │   ├── screen-capture.ts   # desktopCapturer + cursor marker overlay
    │   │   ├── typer.ts            # Clipboard write + Ctrl+V via PowerShell
    │   │   ├── tray.ts             # Grouped tray menu (Services / Recording / History / Pill)
    │   │   ├── preload.ts          # contextBridge for renderer (sandboxed)
    │   │   ├── vad.ts              # Energy-based VAD
    │   │   └── history.ts          # ~/.voxtype/history.json (last 20 — user-visible)
    │   ├── renderer/               # React UI
    │   │   ├── index.html
    │   │   ├── main.tsx
    │   │   ├── App.tsx             # Audio capture, mic pre-warming, silence detection
    │   │   ├── components/
    │   │   │   ├── Pill.tsx        # 6-state liquid orb overlay
    │   │   │   └── Settings.tsx    # In-window settings (currently unused — settings live in tray)
    │   │   └── styles/globals.css  # Tailwind + custom animations
    │   └── shared/
    │       └── types.ts            # AppSettings + IPC channel names + helpers
    └── dist/                       # Built output (electron loads from here)
        ├── main/main/              # tsc output
        └── renderer/               # vite output
```

## Install directory layout (after setup.ps1)

```
~/.voicemode-windows/                # Same as repo dir when cloned here
├── stt-venv/                        # 390 MB — Whisper venv
├── tts-venv/                        # 5.6 GB — Kokoro venv (only if Kokoro installed)
├── Kokoro-FastAPI/                  # 320 MB — Kokoro repo + 313 MB model file
└── voxtype/                         # Built in place; scheduled task launches dist/

~/.voxtype/                          # User data — survives reinstalls
├── settings.json
├── history.json                     # Last 20 dictations (user-visible)
├── debug.log                        # Truncated on every launch
└── sessions.jsonl                   # Truncated on every launch

~/.cache/huggingface/hub/            # Whisper model cache (global)
```

`~/.voicemode/` is a legacy directory from the deleted voice-mode MCP integration. VoxType no longer reads or writes it. `uninstall.ps1` removes it on opt-in.

## Architecture: VoxType owns its services

```
Scheduled Task: VoxType-Dictation   (registered by setup.ps1)
  └─ Action: electron.exe dist/main/main/index.js
       └─ on app.whenReady():
            ├─ if settings.whisperEnabled → services.startWhisper()
            ├─ if settings.kokoroEnabled  → services.startKokoro()
            ├─ tray.createTray()  (status badges refresh every 5 s)
            ├─ hotkey.startHotkeyListener()
            └─ if preloadModel + LM Studio reachable → preload LLM
       └─ on app.before-quit (intercepted, deferred):
            ├─ stopHotkeyListener()
            ├─ stopAutoUnloadTimer()
            └─ services.stopAll()  → taskkill /T (graceful) → /F (forceful)
                └─ then app.exit(0)
```

### `services.ts` — child process manager

The only module that spawns or kills processes. Modeled after telecode's `subprocess.Popen` pattern (`telecode/main.py:113-128`).

```ts
interface Managed {
  proc: ChildProcess | null;
  config: WhisperConfig | KokoroConfig;
  ready: boolean;          // healthcheck passed (HTTP /health → 200)
  stopping: boolean;       // suppresses auto-restart during intentional stop
  restartCount: number;    // exponential backoff on crash
  restartTimer: Timeout | null;
  healthUrl: string;
  lastError?: string;
}
```

**Spawn** (`spawnWhisper` / `spawnKokoro`):
- `windowsHide: true` — no console window
- `stdio: ['ignore', 'pipe', 'pipe']` — capture stdout/stderr for log forwarding
- Whisper: `faster-whisper-server.exe <model> --host 127.0.0.1 --port <port>`, `CUDA_VISIBLE_DEVICES=-1` if CPU device selected
- Kokoro: `uvicorn api.src.main:app --host 127.0.0.1 --port <port>` with `cwd=Kokoro-FastAPI`, `PYTHONUTF8=1`, `USE_GPU=true|false`, `PYTHONPATH=...`

**Healthcheck** (`waitReady`):
- Polls `http://127.0.0.1:<port>/health` every 500 ms
- 60 s total timeout
- Status badge shows `… starting` until `/health` returns 200

**Stop** (`stopService`):
- `taskkill /PID <pid> /T` (graceful — terminates process tree)
- 3 s grace period via `waitExit`
- Then `taskkill /PID <pid> /T /F` (forceful)
- 2 s second grace
- The `/T` flag is critical because uvicorn spawns child workers; without it, workers orphan

**Auto-restart on crash:**
- `proc.on('exit')` handler checks `m.stopping` flag — if false, treats it as a crash
- Exponential backoff: 1 s, 2 s, 4 s, 8 s, 16 s, 32 s (capped at 30 s)
- `restartCount` resets to 0 on next intentional stop

**Status notifications:**
- `onStatusChange(fn)` registers listener
- Tray menu polls `getStatus(name)` directly (not the listener pattern — simpler) every 5 s

### Settings reconciliation

`index.ts:applyServiceChanges(prev, next)` runs after every settings write. Diffs the relevant fields and acts:

| Setting changed | Action |
|---|---|
| `whisperEnabled: false → true` | `startWhisper(...)` |
| `whisperEnabled: true → false` | `stopService('whisper')` |
| `whisperModel`, `whisperPort`, `whisperDevice` (while enabled) | `restartService('whisper', newCfg)` |
| Same trio for Kokoro | Same actions |

This means any tray toggle or model/voice/device change immediately starts, stops, or restarts the right child.

## The pipeline (in `index.ts:handleAudioData`)

```ts
1. estimateDuration(audioBuffer) + audioKB     // build SessionRecord
2. VAD gate: if vadEnabled && (duration < 0.3 || !hasSpeech) → skip
3. Promise.race-style parallel start:
   ├─ screenshotPromise = enhanceEnabled && screenContext ? captureActiveScreen() : null
   └─ transcript = await transcribe(audioBuffer, whisperUrlFor(settings))
4. if transcript empty → skip (logSession with skipped=empty-transcript)
5. if enhanceEnabled:
     screenshot = await screenshotPromise
     finalText = await enhance(transcript, lmStudioUrl, screenshot)
6. if saveHistory → addEntry(transcript, finalText)
7. typeText(finalText, appendMode)              // clipboard + Ctrl+V
8. logSession(rec)                              // append JSONL
9. if autoUnloadMinutes > 0 → resetAutoUnloadTimer
```

Errors surface to `sendError` which both shows a red pill state and pushes an IPC message to renderer.

### `screen-capture.ts` — cursor marker overlay

Electron's `desktopCapturer` on Windows does **not** include the OS cursor. So we paint our own:

1. `screen.getCursorScreenPoint()` → cursor position in global coords
2. `screen.getDisplayNearestPoint(cursor)` → which display the cursor's on
3. `desktopCapturer.getSources({ types: ['screen'], thumbnailSize })` with `thumbnailSize` scaled so max dimension ≤ 1280
4. Match source by `display_id`
5. `nativeImage.getBitmap()` → BGRA buffer
6. Paint red ring (radius 16, thickness 3) + filled center dot (radius 3) at scaled cursor pos
7. `nativeImage.createFromBitmap()` → `.toJPEG(70)` → base64

Buffer manipulation is in pure JS — no native image lib needed. Each pixel is `i = (y * width + x) * 4`, BGRA.

## LLM enhancement (`llm.ts`)

System prompt at `voxtype/resources/system-prompt.md`. Loaded via `loadSystemPrompt()` which reads fresh on every `enhance()` call — no rebuild needed for prompt tweaks. Falls back to a one-line constant if the file is missing.

### Structured output via JSON schema

LM Studio supports OpenAI's `response_format: json_schema` with `strict: true`. Under the hood this uses llama.cpp's grammar-constrained decoding, so the model **physically cannot** produce non-conforming output. Schema:

```ts
{
  type: 'object',
  additionalProperties: false,
  required: ['screen_context', 'cursor_focus', 'edit_plan', 'output'],
  properties: {
    screen_context: { type: 'string', maxLength: 200 },
    cursor_focus:   { type: 'string', maxLength: 150 },
    edit_plan:      { type: 'string', maxLength: 300 },
    output:         { type: 'string' },           // unbounded — long transcripts fit
  },
}
```

`maxLength` on the scratch fields prevents the model from blathering and stealing tokens from `output`. `max_tokens: 4096` is the hard cap.

### Output extraction

`extractOutput(raw)` tries 4 strategies in order:

1. `JSON.parse(text)` → `.output`
2. Find largest `{...}` substring, parse, extract `.output`
3. Regex `"output"\s*:\s*"((?:[^"\\]|\\.)*)"`
4. Whole raw content (pre-schema fallback)

The JSON schema strict mode usually means strategy 1 always works, but the fallbacks exist for robustness against model misbehavior.

### Sanity checks (`cleanLLMOutput`)

After extraction:
- Strip code fences, wrapping quotes, leftover `<transcript>` tags
- Empty output + non-empty input → return original transcript
- Output > 3× input length → likely hallucination → return original

### Cache

LRU map of size 50, keyed by transcript + screenshot fingerprint (length + first 32 chars of base64). Identical re-dictations skip the LLM call.

### Auto-unload

`resetAutoUnloadTimer(minutes, lmStudioUrl)` schedules a one-shot timer:
1. Unload LM Studio model via `/api/v1/models/unload` POST
2. `services.restartService('whisper')` if running — frees Whisper VRAM
3. `services.restartService('kokoro')` if running — frees Kokoro VRAM

After unload, next dictation re-loads (adds 2–10 s for first dictation only).

## Tray menu (`tray.ts`)

Top-level structure (Menu.buildFromTemplate):

```
Hold to talk           (radio)
Toggle on/off          (radio)
─────────
Hotkey: …              (click to enter capture mode)
─────────
Services ▶
  Whisper (STT) — ● ready ▶
    Status: …          (disabled label)
    Enabled            (checkbox)
    ── Model ──
    {WHISPER_MODELS}   (radios)
    ── Device ──
    GPU/CPU            (radios)
    Restart now        (click)
  Kokoro (TTS) — ○ off ▶
    (same shape)
  LM Studio (LLM) ▶
    Enhance transcript (checkbox)
    Screen context     (checkbox)
    ── Model ──
    {available models} (radios)
    Auto-unload after ▶
    Preload on startup (checkbox)
    Refresh models     (click)
Recording ▶
  {3 toggles}
History ▶
  Save history         (checkbox)
  ── Recent ──
  {last 10 entries}    (clickable, copies enhanced)
  Clear history        (click)
Pill ▶
  Show/Hide pill       (click)
  Reset position       (click)
─────────
Quit                   (click → app.quit())
```

`rebuildMenu()` is called on every state change AND every 5 s by `setInterval` so service status badges live-update.

## Settings (`shared/types.ts`)

```ts
interface AppSettings {
  // Recording
  hotkeyMode: 'hold' | 'toggle';
  hotkey: HotkeyCombo;
  autoStopOnSilence: boolean;
  vadEnabled: boolean;
  appendMode: boolean;

  // Pill
  pillX: number;            // -1 = use default (bottom-center)
  pillY: number;

  // Whisper
  whisperEnabled: boolean;
  whisperPort: number;
  whisperModel: string;
  whisperDevice: 'gpu' | 'cpu';

  // Kokoro
  kokoroEnabled: boolean;   // off by default
  kokoroPort: number;
  kokoroVoice: string;
  kokoroDevice: 'gpu' | 'cpu';

  // LM Studio (external — VoxType doesn't manage)
  enhanceEnabled: boolean;
  screenContext: boolean;
  lmStudioUrl: string;
  llmModel: string;         // empty = auto-pick smallest
  preloadModel: boolean;
  autoUnloadMinutes: number;

  // History
  saveHistory: boolean;
}
```

`whisperUrlFor(settings)` derives the URL from the port — there's no longer a stored `whisperUrl` field.

## IPC channels

```ts
IPC = {
  // Main → Renderer
  START_RECORDING: 'start-recording',
  STOP_RECORDING:  'stop-recording',
  STATE_CHANGE:    'state-change',     // (state: PillState, detail?: string)
  ERROR:           'error',            // (msg: string)

  // Renderer → Main
  AUDIO_DATA:      'audio-data',       // (audioBuffer: Buffer)
  GET_SETTINGS:    'get-settings',     // returns AppSettings
  SET_SETTINGS:    'set-settings',     // (partial: Partial<AppSettings>) → AppSettings
  CANCEL:          'cancel',
}
```

`AUDIO_DATA` is a `webm`/`opus`-encoded Buffer from `MediaRecorder` in the renderer. The main process forwards it to Whisper as multipart/form-data with field name `file`.

## Hotkey listener (`hotkey.ts`)

`uiohook-napi` provides cross-platform global hotkeys. VoxType uses it as a low-level keydown/keyup stream and implements its own state machine.

Key behaviors:

- **Auto-repeat suppression** — Windows fires `keydown` continuously while a key is held. The handler ignores any `keydown` for a key already in the `heldKeys` set. Without this, toggle mode flips on/off when you hold the key past the OS auto-repeat delay.
- **Combo matching** — `combo.key1` + optional `combo.key2`. `key2 === undefined` means single-key hotkey.
- **Modifier normalization** — Left/Right Ctrl/Shift/Alt/Win all normalize to the left-side keycode.
- **Capture mode** — `captureHotkey()` returns a Promise. Waits for all currently-held keys to release before arming (so menu accelerator keys don't leak in), then captures the next 1 or 2 keys pressed together. 2-key combos resolve on the second `keydown`; 1-key resolves on `keyup` if only one key was pressed.

## Logging architecture

`debug-log.ts` runs `initDebugLog()` as the very first thing in `index.ts` (before any other import that might log at module load).

```ts
console.log = (...args) => { origLog(...args); appendToFile('LOG', args); };
console.warn = ...
console.error = ...
```

Output format: `[ISO timestamp] LEVEL message\n`

`logSession(record)` appends one JSON line to `sessions.jsonl`. SessionRecord fields:

```ts
{
  ts: ISO timestamp,
  durationSec: number,
  audioKB: number,
  hadScreenshot?: boolean,
  screenshotKB?: number,
  model?: string,             // LLM model id
  sttMs?: number,
  llmMs?: number,
  totalMs?: number,
  raw?: string,               // Whisper output
  enhanced?: string,          // post-LLM
  skipped?: 'too-short' | 'no-speech' | 'empty-transcript' | 'cancelled',
  error?: string,
}
```

Both files truncate on every launch (matches telecode's pattern). User-visible history (`history.json`) is separate and persistent.

## Build

```powershell
cd voxtype
npm run build:main      # tsc -p tsconfig.node.json → dist/main/
npx vite build          # → dist/renderer/
# OR all at once:
npm run build           # both
```

The scheduled task launches `dist/main/main/index.js`. Source edits in `voxtype/src/` have **no runtime effect** until you rebuild. **Always rebuild before committing source changes** — the repo IS the install dir, so an unbuilt `dist/` means the running app silently runs old code.

System prompt edits (`voxtype/resources/system-prompt.md`) do NOT need a rebuild — they're read at runtime.

## Common dev tasks

### Run in dev mode with hot reload

```powershell
cd voxtype && npm run dev
```

Vite serves the renderer at `http://localhost:5173`; Electron loads from there. Main process changes still need rebuild.

### Tail logs during a dictation

```powershell
Get-Content "$env:USERPROFILE\.voxtype\debug.log" -Wait -Tail 50
```

### Check service health while VoxType is running

```powershell
curl http://127.0.0.1:6600/health   # Whisper
curl http://127.0.0.1:6500/health   # Kokoro (if enabled)
curl http://127.0.0.1:1234/v1/models  # LM Studio
```

### Manually start / stop / restart task

```powershell
schtasks /run /tn VoxType-Dictation
schtasks /end /tn VoxType-Dictation
```

### Re-register the scheduled task without full setup

```powershell
.\setup.ps1   # idempotent — skips heavy steps; always re-registers task
```

### Clean reinstall (keep models cached)

```powershell
.\uninstall.ps1   # decline removal of ~/.voxtype/ to keep settings
.\setup.ps1
```

### Inspect last dictation in detail

```powershell
Get-Content "$env:USERPROFILE\.voxtype\sessions.jsonl" | Select-Object -Last 1 | ConvertFrom-Json | Format-List
```

## Coding conventions

- **No comments unless the WHY is non-obvious.** Identifier names should explain WHAT.
- **No backwards-compatibility shims.** When you remove a feature, remove all of it — settings, IPC channels, comments referencing it. The old voice-mode MCP integration is a good example: nothing references it now.
- **No dead code, no commented-out blocks.** Delete it; git remembers.
- **No new dependencies without justification.** `services.ts` is pure Node + child_process + http — no `pidusage`, no `tree-kill`, no `ps-tree`. The Windows `taskkill /T` command does what we need.
- **No silent failures.** Errors surface to `sendError` (red pill state + IPC to renderer) AND `console.error` (which goes to debug.log).
- **Structured output for LLM calls.** JSON schema with `strict: true` is non-negotiable. Without it, every small model adds chat-style preamble.
- **Idempotent install.** Setup must be safely re-runnable. File-existence checks gate heavy non-pip steps; pip itself handles "already installed".

## Pitfalls / gotchas

- **`heldKeys.has(key)` early-return in keydown handler.** Removing this re-introduces the toggle-flicker bug.
- **`taskkill /T` (without /F first).** uvicorn spawns workers; without `/T`, killing the parent leaves workers running. Always `/T` then escalate to `/T /F`.
- **`before-quit` event preventDefault.** We need async cleanup (taskkill is fire-and-forget but waitExit isn't), so we `e.preventDefault()` and call `app.exit(0)` after stopAll. Without preventDefault, Electron exits before children are stopped.
- **`SET_SETTINGS` IPC handler is async.** It calls `applyServiceChanges` which can spawn/kill processes. Tray handlers `await` it implicitly via the Promise chain.
- **`require('./services')` in `llm.ts:resetAutoUnloadTimer`.** Circular import dance — `services.ts` doesn't import from `llm.ts`, but `llm.ts`'s auto-unload needs to call services. `require` inside the timer callback breaks the circular load chain.
- **Hot-reload of system-prompt.md.** `loadSystemPrompt()` reads from disk on every `enhance()` call. Don't cache it.
- **Cursor marker bitmap edit.** Buffer is BGRA, not RGBA — first byte is Blue.
- **Max image dim 1280px.** Larger payloads hit LM Studio context limits on smaller models. Don't raise without testing.
- **Health endpoint is /health, not /v1/health.** Both Whisper and Kokoro expose it directly.

## Workflow rules

- **Always rebuild VoxType `dist/` after committing source changes.** Otherwise the running app silently runs old code. Use `npm run build:main` for main process changes, `npx vite build` for renderer changes, or both.
- **System prompt edits don't need a rebuild.**
- **Don't delete `~/.voxtype/history.json`** when debugging — that's user-visible data. Use `debug.log` and `sessions.jsonl`.
- **Test on a clean install at least once per release.** Setup idempotency claims are easy to break (e.g. forgetting to gate a `git clone` on `Test-Path`).
- **Log changes to user-visible behavior in commit messages.** Internal refactors don't need it; UX changes do.

## Migration notes (from pre-refactor)

If you're reading this and the install on disk still has the old layout:

- Three scheduled tasks (`VoiceMode-Whisper-STT`, `VoiceMode-Kokoro-TTS`, `VoxType-Dictation`) → `setup.ps1` cleans up the legacy two automatically
- `mcp-venv/` directory → safe to `rm -rf`; nothing reads it
- `~/.voicemode/` directory → safe to `rm -rf`; only the legacy MCP read it
- `start-whisper-stt.{bat,vbs}` etc. → already deleted from the repo; if present in your install, safe to remove
- `patches/` directory → already deleted; safe to remove
- `configure-claude.ps1` → already deleted

Run `uninstall.ps1` then `setup.ps1` for the cleanest path. `uninstall.ps1` will prompt before removing `~/.voxtype/` and the install dir, so you can keep your settings.

## Dependencies

| Component | Version | Source |
|---|---|---|
| Electron | ^35.0.0 | npm |
| React | ^19.0.0 | npm |
| uiohook-napi | ^1.5.4 | npm |
| Tailwind CSS | ^4.1.3 | npm |
| Vite | ^6.3.0 | npm |
| TypeScript | ^5.7.0 | npm |
| faster-whisper-server | 0.0.2 | PyPI |
| ctranslate2 | latest | PyPI (transitive — Whisper's GPU path) |
| Kokoro-FastAPI | 0.3.x | GitHub: remsky/Kokoro-FastAPI |
| PyTorch | 2.9.x+cu129 | pytorch.org (Kokoro only) |

## What's NOT here (and why)

- **No app-context detection** — Wispr Flow's killer feature (per-app tone) requires Windows UI Automation + per-app prompt presets. Real work, not yet started.
- **No snippets / personal dictionary** — would need a settings UI for trigger-phrase → expansion mappings; manageable but not yet built.
- **No wake word** — would need an always-on tiny model (e.g. openWakeWord) running in another child process.
- **No streaming transcription** — Whisper's API doesn't support it well; faster-whisper-server is also batch-only.
- **No Linux/macOS support** — uiohook keycodes, taskkill, transparent flags, the install scripts — all Windows-specific.
- **No auto-update** — manual `git pull && setup.ps1`.
