# VoxType — Python package

User-facing docs: [../README.md](../README.md).
Engineering notes: [../CLAUDE.md](../CLAUDE.md).

## Package layout

```
voxtype/
  main.py              # Orchestrator: Qt loop + asyncio worker
  audio.py             # sounddevice → 16 kHz mono int16 PCM
  hotkey.py            # pynput keyboard listener
  vad.py               # numpy RMS gate
  screen_capture.py    # mss + PIL, red cursor marker
  history.py           # append-only JSON
  typer.py             # clipboard + Ctrl+V via PowerShell SendKeys

  stt_engine.py        # In-process STT — sherpa-onnx + HF auto-download
  tts_engine.py        # In-process TTS — onnxruntime/piper-tts + HF auto-download
  stt.py               # Thin shim → stt_engine
  server.py            # Embedded aiohttp /v1/audio/* server
  llm.py               # OpenAI-shape POST to telecode proxy
  process.py           # Status facade over engines + kept-around Job Object utils

  qt_theme.py          # Dark QSS
  tray_menu.py         # QSystemTrayIcon + STT / TTS / LLM submenus
  pill_window.py       # Always-on-top status pill
  settings_window.py   # Sidebar settings UI

  types.py             # AppSettings, HotkeyCombo, PillState
  config.py            # Atomic JSON I/O + hot reload
  debug_log.py         # Rotating file logger

  resources/
    icon.png
    system-prompt.md   # LLM cleanup instructions
```

## Run

```powershell
pip install -r voxtype/requirements.txt
python -m voxtype
```

## Data dir

`%USERPROFILE%\.voxtype\voxtype\data\` by default. Override with
`VOXTYPE_DATA_DIR`.
