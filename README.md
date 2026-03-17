# VoiceMode Windows

Local voice input/output for [Claude Code](https://claude.ai/claude-code) on Windows. Fully offline STT (Whisper) + TTS (Kokoro) with GPU acceleration.

Includes **VoxType** — a local Wispr Flow alternative that lets you dictate into any Windows app with a global hotkey.

## What it does

- **Speech-to-Text**: Local [faster-whisper-server](https://github.com/fedirz/faster-whisper-server) with OpenAI-compatible API
- **Text-to-Speech**: Local [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) with GPU support
- **MCP Integration**: Patched [VoiceMode](https://github.com/mbailey/voicemode) MCP server for Windows
- **VoxType Dictation**: Electron overlay app — press hotkey, speak, text appears at cursor
- **No cloud APIs**: Everything runs locally, full privacy
- **Auto-start**: Task Scheduler integration for boot-time startup (hidden, no console window)

## Prerequisites

- Windows 10/11
- Python 3.10+ (3.12 recommended)
- Node.js 18+ (for VoxType)
- Git
- ffmpeg (in PATH)
- NVIDIA GPU (optional, for Kokoro TTS acceleration)
- [Claude Code](https://claude.ai/claude-code) installed
- [LM Studio](https://lmstudio.ai/) with any model loaded (for VoxType enhancement, optional)

## Quick Start

```powershell
git clone https://github.com/prskid1000/voicemode-windows.git
cd voicemode-windows
.\setup.ps1
```

Setup will:
1. Install VoiceMode MCP with Windows patches
2. Install Whisper STT + Kokoro TTS services
3. Build and install VoxType dictation app
4. Create scheduled tasks for all 3 services
5. Start everything immediately

## VoxType — Voice Dictation

Press your hotkey (default: **Ctrl+Win**), speak, release — text appears at your cursor in any app.

### Features

- **Instant recording** — mic pre-warmed, no startup delay
- **LLM enhancement** — cleans up filler words, fixes punctuation, formats numbers via local LM Studio
- **Auto-stop on silence** — stops recording after 2s of silence
- **VAD noise gate** — skips sending empty audio to Whisper
- **Custom hotkey** — any two-key combo (click "Hotkey" in tray to set)
- **Whisper model selector** — switch between Tiny/Base/Small/Medium/Large v3 from tray
- **Kokoro voice selector** — 15 featured voices for VoiceMode TTS
- **Transcription history** — last 20 entries, click to copy from tray
- **Append mode** — append text after cursor instead of replacing selection
- **Multi-monitor** — pill follows cursor to the active display
- **Draggable pill** — drag to reposition, position persists across restarts
- **Minimal UI** — 28px orb with animated states, expands only during recording

### Pill States

| State | Visual |
|-------|--------|
| Idle | Dark orb with breathing aurora glow |
| Recording | Red pill with pulsing dot + live waveform |
| Transcribing | Orb with amber spinner |
| Enhancing | Orb with indigo sparkle |
| Done | Orb with green checkmark |
| Error | Orb with red lightning bolt |

### Tray Menu

Right-click the VoxType tray icon for settings:
- Recording mode (hold / toggle)
- Hotkey customization
- Whisper model selection (restarts service automatically)
- Kokoro voice selection
- LLM enhance toggle
- Append mode
- Auto-stop on silence
- VAD noise gate
- History with copy-to-clipboard

## Auto-Start (Task Scheduler)

Setup creates three scheduled tasks automatically:

| Task | Service |
|------|---------|
| `VoiceMode-Whisper-STT` | Whisper STT server (port 6600) |
| `VoiceMode-Kokoro-TTS` | Kokoro TTS server (port 6500) |
| `VoxType-Dictation` | Dictation overlay app |

All tasks run hidden, auto-restart on crash, no password required (S4U logon).

```powershell
# Manual control
schtasks /run /tn VoiceMode-Whisper-STT
schtasks /run /tn VoiceMode-Kokoro-TTS
schtasks /run /tn VoxType-Dictation

# Stop
schtasks /end /tn VoiceMode-Whisper-STT
schtasks /end /tn VoiceMode-Kokoro-TTS
schtasks /end /tn VoxType-Dictation
```

## Usage in Claude Code

After setup and restarting Claude Code:

```
# Start a voice conversation
/mcp__voicemode__converse
```

## Architecture

```
Claude Code                          Any Windows App
    |                                      ^
    v                                      |
VoiceMode MCP (patched)              VoxType (Electron)
    |                                 |          |
    +---> Kokoro TTS --> Speaker      |    LM Studio
    |     :6500                       |    :1234
    |                                 |
    +---> Mic --> Whisper STT <-------+
                  :6600
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VOICEMODE_STT_BASE_URLS` | `http://127.0.0.1:6600/v1` | Whisper STT endpoint |
| `VOICEMODE_TTS_BASE_URLS` | `http://127.0.0.1:6500/v1` | Kokoro TTS endpoint |
| `VOICEMODE_VOICES` | `af_sky,alloy` | Kokoro voice (set via VoxType tray) |

## Troubleshooting

### VoxType: First words get cut off
This was fixed with mic pre-warming. If it still happens, check that the Electron app has microphone permissions in Windows Settings > Privacy > Microphone.

### VoxType: LLM rewrites my words
The enhancement prompt is designed to preserve your exact words. If it's still too aggressive, disable "LLM enhance" in the tray menu to get raw Whisper output.

### Services not starting
```powershell
netstat -ano | findstr "6500 6600"
```

### STT returns empty
Switch to a larger Whisper model via VoxType tray > Whisper model, or:
```powershell
.\setup.ps1 -WhisperModel "Systran/faster-whisper-medium"
```

## Uninstall

```powershell
.\uninstall.ps1
```

Removes all scheduled tasks, VoxType data, and optionally the install directory.

## Credits

- [VoiceMode](https://github.com/mbailey/voicemode) by Mike Bailey
- [faster-whisper-server](https://github.com/fedirz/faster-whisper-server) by fedirz
- [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) by remsky
- [Claude Code](https://claude.ai/claude-code) by Anthropic
- Inspired by [Wispr Flow](https://wisprflow.ai/)

## License

MIT
