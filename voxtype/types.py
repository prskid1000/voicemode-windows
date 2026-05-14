"""Settings + UI state types. Single source of truth.

STT and TTS both run in-process via PyTorch. An embedded HTTP server
(single port, default 6600) exposes them to external clients via
OpenAI-compatible endpoints — see voxtype/server.py.

Architecture: one generic STT backend and one generic TTS backend
auto-dispatch by HuggingFace `config.json` model_type / pipeline_tag
to the right handler (Whisper, Wav2Vec2, MMS, Seamless, Moonshine,
Kokoro, VITS, SpeechT5, Bark, Parler, …). Per-family knobs live in
the free-form `stt_opts` / `tts_opts` dicts so the UI can render
them dynamically without AppSettings ever needing to know about
family-specific fields.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Literal

PillState = Literal["idle", "recording", "processing", "enhancing", "typing", "error"]
HotkeyMode = Literal["hold", "toggle"]
# torch device preference. Used by both STT and TTS engines.
TorchDevice = Literal["cpu", "cuda"]
# Inference precision. `auto` = fp16 on CUDA, fp32 on CPU. `bf16` needs
# Ampere+ (RTX 30xx / A100+) — same speed as fp16, wider numeric range.
TorchDtype = Literal["auto", "fp32", "fp16", "bf16"]


@dataclass
class HotkeyCombo:
    """One or two keys that must be held together to activate the hotkey.

    Keys use pynput-style string names (e.g. "ctrl", "cmd", "f9") so we
    don't carry the Windows/uiohook numeric keycode over. `label` is
    human-readable."""
    key1: str = "ctrl"
    key2: str | None = "cmd"
    label: str = "Ctrl + Win"


# Old top-level keys → new opts-bag keys. Read on settings load to
# migrate existing settings.json files without dropping user prefs.
_STT_OPTS_MIGRATIONS: dict[str, str] = {
    "stt_task":            "task",
    "stt_num_beams":       "num_beams",
    "stt_initial_prompt":  "initial_prompt",
}
_TTS_OPTS_MIGRATIONS: dict[str, str] = {
    "tts_length_scale":    "speed",
}


@dataclass
class AppSettings:
    # ── Recording behavior ───────────────────────────────────────────
    hotkey_mode: HotkeyMode = "hold"
    hotkey: HotkeyCombo = field(default_factory=HotkeyCombo)
    auto_stop_on_silence: bool = True
    silence_duration_sec: float = 1.5
    vad_enabled: bool = True
    append_mode: bool = False

    # ── Pill UI position (-1 = unset → center-bottom) ────────────────
    pill_x: int = -1
    pill_y: int = -1
    pill_hidden: bool = False

    # ── Embedded HTTP server ─────────────────────────────────────────
    server_enabled: bool = True
    server_port: int = 6600

    # ── STT (in-process via transformers + torch) ───────────────────
    # `stt_model_path` accepts a HF repo ID (auto-downloaded) or a local
    # path. Paste anything — Whisper, Wav2Vec2, HuBERT, MMS, Seamless,
    # Moonshine, SpeechT5 — the generic backend sniffs the model's
    # config.json and picks the right loader.
    stt_enabled: bool = True
    stt_auto_start: bool = True
    stt_idle_unload_sec: int = 300
    stt_backend: str = "generic"             # always "generic" in normal use
    stt_model_path: str = "openai/whisper-base"
    stt_device: TorchDevice = "cpu"
    stt_language: str = "en"                  # universal — every multilingual
                                              # family honours it
    stt_dtype: TorchDtype = "auto"
    stt_warmup: bool = True
    stt_torch_compile: bool = False
    # Family-specific per-call options. Populated by the UI from the
    # active backend's runtime_options() spec list. Keys depend on the
    # detected family — Whisper writes `task`, `num_beams`,
    # `initial_prompt`; Bark writes `temperature`; Parler writes
    # `style`; etc.
    stt_opts: dict[str, Any] = field(default_factory=dict)

    # ── TTS (in-process via torch + assorted model libs) ────────────
    # `tts_model_path` accepts any HF repo (Kokoro, MMS-TTS, SpeechT5,
    # Bark, Parler) or a local path. Voice list is rebuilt per-backend.
    tts_enabled: bool = False
    tts_auto_start: bool = False
    tts_idle_unload_sec: int = 600
    tts_backend: str = "generic"
    tts_model_path: str = "hexgrad/Kokoro-82M"
    tts_device: TorchDevice = "cpu"
    tts_voice: str = "af_heart"               # universal — every backend
                                              # picks a voice some way
    tts_speed: float = 1.0                    # universal-gated (suppressed
                                              # for backends without speed)
    tts_warmup: bool = True
    tts_torch_compile: bool = False
    tts_stream: bool = False
    # Family-specific per-call options (style prompt for Parler,
    # speaker_embedding for SpeechT5, temperature for Bark, etc.).
    tts_opts: dict[str, Any] = field(default_factory=dict)

    # ── LLM enhancement (via telecode proxy) ─────────────────────────
    enhance_enabled: bool = True
    screen_context: bool = True
    proxy_url: str = "http://127.0.0.1:1235"
    proxy_model: str = "qwen3.5-35b"

    # ── History ──────────────────────────────────────────────────────
    save_history: bool = True

    # ── Serialization helpers ────────────────────────────────────────

    def to_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, d: dict) -> "AppSettings":
        hk = d.get("hotkey") or {}
        settings = cls(
            hotkey=HotkeyCombo(
                key1=hk.get("key1", "ctrl"),
                key2=hk.get("key2"),
                label=hk.get("label", "Ctrl + Win"),
            ),
        )
        # Apply known fields first.
        for key, value in d.items():
            if key == "hotkey":
                continue
            if hasattr(settings, key):
                setattr(settings, key, value)

        # ── Migrations from the pre-opts-bag schema ──────────────────
        # Family-specific STT fields → stt_opts.
        for old_key, new_key in _STT_OPTS_MIGRATIONS.items():
            if old_key in d and new_key not in settings.stt_opts:
                settings.stt_opts[new_key] = d[old_key]
        # Family-specific TTS fields → tts_opts.
        for old_key, new_key in _TTS_OPTS_MIGRATIONS.items():
            if old_key in d and new_key not in settings.tts_opts:
                settings.tts_opts[new_key] = d[old_key]
        # Voice key rename: tts_speaker → tts_voice.
        if "tts_speaker" in d and not d.get("tts_voice"):
            settings.tts_voice = str(d["tts_speaker"] or "af_heart")
        # tts_length_scale → tts_speed (top-level).
        if "tts_length_scale" in d and "tts_speed" not in d:
            try:
                settings.tts_speed = float(d["tts_length_scale"] or 1.0)
            except (TypeError, ValueError):
                pass
        # Old backend names (`whisper`, `kokoro`) → `generic`. The new
        # backend covers them via family detection.
        if settings.stt_backend not in {"generic"}:
            settings.stt_backend = "generic"
        if settings.tts_backend not in {"generic"}:
            settings.tts_backend = "generic"
        return settings


def server_url(s: AppSettings) -> str:
    """Base URL for the embedded STT/TTS server."""
    return f"http://127.0.0.1:{s.server_port}"
