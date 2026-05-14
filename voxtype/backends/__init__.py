"""Pluggable STT / TTS backends.

VoxType ships ONE generic STT backend and ONE generic TTS backend that
between them cover almost every open-source model family available on
HuggingFace: Whisper, Wav2Vec2, HuBERT, WavLM, MMS, SeamlessM4T,
Moonshine, Speech2Text, SpeechT5 (ASR + TTS), Qwen-Audio, Parakeet,
VITS / MMS-TTS, Bark, Parler-TTS, Kokoro, and anything else HF
registers under `automatic-speech-recognition` / `text-to-speech`.

Pasting any HF repo id (or local path) into the model field is the
only user action — the backend sniffs the model's config.json,
auto-detects its family, and exposes the right per-family options.
"""
from __future__ import annotations

import logging
from typing import Type

from voxtype.backends.stt_base import STTBackend
from voxtype.backends.tts_base import TTSBackend

log = logging.getLogger("voxtype.backends")


# ── STT registry ─────────────────────────────────────────────────────

_STT: dict[str, Type[STTBackend]] = {}


def _register_stt(name: str, module_path: str, cls_name: str) -> None:
    try:
        mod = __import__(module_path, fromlist=[cls_name])
        _STT[name] = getattr(mod, cls_name)
    except Exception as exc:  # noqa: BLE001
        log.info("stt backend %r unavailable: %s", name, exc)


_register_stt("generic", "voxtype.backends.generic_stt", "GenericSTTBackend")


def stt_backend_names() -> list[str]:
    return list(_STT.keys())


def get_stt_backend(name: str = "generic") -> STTBackend:
    cls = _STT.get(name) or _STT.get("generic")
    if cls is None:
        raise RuntimeError("no STT backend available (transformers missing?)")
    return cls()


def resolve_stt_backend(model_id: str = "") -> STTBackend:
    """Pick a backend instance to handle `model_id`. The generic backend
    always wins — it dispatches internally to a family-specific handler."""
    return get_stt_backend("generic")


# ── TTS registry ─────────────────────────────────────────────────────

_TTS: dict[str, Type[TTSBackend]] = {}


def _register_tts(name: str, module_path: str, cls_name: str) -> None:
    try:
        mod = __import__(module_path, fromlist=[cls_name])
        _TTS[name] = getattr(mod, cls_name)
    except Exception as exc:  # noqa: BLE001
        log.info("tts backend %r unavailable: %s", name, exc)


_register_tts("generic", "voxtype.backends.generic_tts", "GenericTTSBackend")


def tts_backend_names() -> list[str]:
    return list(_TTS.keys())


def get_tts_backend(name: str = "generic") -> TTSBackend:
    cls = _TTS.get(name) or _TTS.get("generic")
    if cls is None:
        raise RuntimeError("no TTS backend available")
    return cls()


def resolve_tts_backend(model_id: str = "") -> TTSBackend:
    return get_tts_backend("generic")
