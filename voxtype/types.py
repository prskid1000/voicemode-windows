"""Settings + UI state types. Single source of truth.

STT and TTS both run in-process via ONNX Runtime. An embedded HTTP
server (single port, default 6600) exposes them to external clients
via OpenAI-compatible endpoints — see voxtype/server.py.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Literal

PillState = Literal["idle", "recording", "processing", "enhancing", "typing", "error"]
HotkeyMode = Literal["hold", "toggle"]
# ONNX Runtime provider preference. Used by both STT and TTS.
OnnxDevice = Literal["cpu", "cuda"]


@dataclass
class HotkeyCombo:
    """One or two keys that must be held together to activate the hotkey.

    Keys use pynput-style string names (e.g. "ctrl", "cmd", "f9") so we don't
    carry the Windows/uiohook numeric keycode over. `label` is human-readable."""
    key1: str = "ctrl"
    key2: str | None = "cmd"
    label: str = "Ctrl + Win"


@dataclass
class AppSettings:
    # ── Recording behavior ───────────────────────────────────────────
    hotkey_mode: HotkeyMode = "hold"
    hotkey: HotkeyCombo = field(default_factory=HotkeyCombo)
    auto_stop_on_silence: bool = True
    silence_duration_sec: float = 1.5   # seconds of continuous silence
                                         # before the recorder auto-stops
    vad_enabled: bool = True
    append_mode: bool = False

    # ── Pill UI position (-1 = unset → center-bottom) ────────────────
    pill_x: int = -1
    pill_y: int = -1
    pill_hidden: bool = False

    # ── Embedded HTTP server (serves both STT + TTS) ─────────────────
    # Default 6600 — external clients reach VoxType through this port
    # via OpenAI-compatible routes.
    server_enabled: bool = True
    server_port: int = 6600

    # ── STT (in-process via ONNX Runtime) ────────────────────────────
    # `stt_model_path` points at the encoder `.onnx` file (decoder and
    # tokens.txt are auto-located next to it). Any sherpa-onnx-compatible
    # export works.
    stt_enabled: bool = True
    stt_auto_start: bool = True
    stt_idle_unload_sec: int = 300
    stt_model_path: str = ""
    stt_device: OnnxDevice = "cpu"
    stt_language: str = "en"

    # ── TTS (in-process via ONNX Runtime) ────────────────────────────
    # Off by default. The model_path points at an ONNX file (paired
    # `.onnx.json` is auto-located). Voice selection IS the model file —
    # no separate voice list.
    tts_enabled: bool = False
    tts_auto_start: bool = False
    tts_idle_unload_sec: int = 600
    tts_model_path: str = ""
    tts_device: OnnxDevice = "cpu"
    tts_speaker: int = 0               # speaker index for multi-speaker models
    tts_length_scale: float = 1.0      # >1 = slower; OpenAI speed is its inverse
    tts_noise_scale: float = 0.667
    tts_noise_w: float = 0.8

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
        # Copy remaining fields (skip hotkey — handled above)
        for key, value in d.items():
            if key == "hotkey":
                continue
            if hasattr(settings, key):
                setattr(settings, key, value)
        return settings


def server_url(s: AppSettings) -> str:
    """Base URL for the embedded STT/TTS server."""
    return f"http://127.0.0.1:{s.server_port}"
