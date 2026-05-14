"""TTS engine orchestrator — owns lifecycle, delegates to a backend.

The actual synthesis is done by a swappable
`voxtype.backends.TTSBackend` instance (the generic backend in normal
use). This module handles:
  - load / unload locking
  - idle-unload watcher
  - status listeners
  - per-call streaming bridge (sync generator → async queue → caller)
  - rebuild-on-config-change via `_key()`

Per-family options live in `settings.tts_opts` (a free-form dict).
The universal `tts_voice` and `tts_speed` are first-class fields on
AppSettings; everything else (style prompts, speaker embeddings,
sampling temperature, reference audio for cloning) lives in tts_opts.
"""
from __future__ import annotations

import asyncio
import io
import logging
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable

from voxtype.backends import (
    get_tts_backend, resolve_tts_backend, tts_backend_names,
)
from voxtype.backends.tts_base import TTSBackend, TTSLoadConfig

log = logging.getLogger("voxtype.tts_engine")


DEFAULT_MODEL = "hexgrad/Kokoro-82M"
DEFAULT_VOICE = "af_heart"


def available_backends() -> list[str]:
    return tts_backend_names()


def _safe_backend(name: str = "generic") -> TTSBackend | None:
    try:
        return get_tts_backend(name)
    except Exception as exc:  # noqa: BLE001
        log.warning("tts backend %r unavailable: %s", name, exc)
        return None


def voice_combo_options(backend_name: str | None = None) -> list[tuple[str, str]]:
    """Voice catalog from a NOT-yet-loaded backend instance. For the
    generic backend this returns an empty list pre-load; the UI shows
    a placeholder and rebuilds the picker once the model loads."""
    be = _safe_backend(backend_name or "generic")
    return be.voice_combo_options() if be else []


def all_voice_ids(backend_name: str | None = None) -> set[str]:
    be = _safe_backend(backend_name or "generic")
    return be.voice_ids() if be else set()


def default_voice_for(backend_name: str) -> str:
    be = _safe_backend(backend_name)
    return be.default_voice if be else DEFAULT_VOICE


def default_model_for(backend_name: str) -> str:
    be = _safe_backend(backend_name)
    return be.default_model if be else DEFAULT_MODEL


@dataclass
class TTSStatus:
    running: bool = False
    ready: bool = False
    pid: int | None = None
    last_error: str = ""
    backend: str = ""
    family: str = ""

    @property
    def name(self) -> str:
        return "tts"


class TTSEngine:
    """Singleton — call `get_engine()`. Thread-safe."""

    def __init__(self) -> None:
        self._backend: TTSBackend | None = None
        self._backend_name: str = ""
        self._model_lock = asyncio.Lock()
        self._exec = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voxtype-tts")
        self._loaded_key: tuple | None = None
        self._status = TTSStatus()
        self._listeners: list[Callable[[TTSStatus], None]] = []
        self._last_used = 0.0
        self._idle_unload_sec = 0
        self._idle_watch_started = False

        self._model_path = ""
        self._device = "cpu"
        self._voice = ""
        self._speed = 1.0
        self._warmup = True
        self._torch_compile = False
        self._stream_default = False
        self._opts: dict[str, Any] = {}

    # ── Listener wiring ──────────────────────────────────────────────

    def on_status_change(self, fn: Callable[[TTSStatus], None]) -> None:
        self._listeners.append(fn)

    def get_status(self) -> TTSStatus:
        family = ""
        if self._backend is not None:
            try:
                family = self._backend.detected_family() or ""
            except Exception:
                family = ""
        return TTSStatus(
            running=self._status.running,
            ready=self._status.ready,
            pid=None,
            last_error=self._status.last_error,
            backend=self._backend_name,
            family=family,
        )

    def get_backend(self) -> TTSBackend | None:
        return self._backend

    def _notify(self) -> None:
        for fn in list(self._listeners):
            try:
                fn(self.get_status())
            except Exception:
                pass

    # ── Configuration ────────────────────────────────────────────────

    def _effective_model(self) -> str:
        if self._model_path:
            return self._model_path
        if self._backend is not None:
            return self._backend.default_model
        return DEFAULT_MODEL

    def _effective_voice(self) -> str:
        """Validate voice against the loaded backend's catalog. If the
        catalog is empty (generic backend pre-load), accept the user
        value as-is — the family handler will fall back to its default
        when the catalog appears."""
        v = (self._voice or "").strip()
        be = self._backend
        if be is None:
            return v or DEFAULT_VOICE
        ids = be.voice_ids()
        if not ids:
            return v or (be.default_voice or DEFAULT_VOICE)
        if v in ids:
            return v
        return be.default_voice or next(iter(ids), DEFAULT_VOICE)

    def _key(self) -> tuple:
        return (
            "generic",
            self._effective_model(), self._device,
            bool(self._torch_compile),
        )

    async def configure(self, s) -> None:
        self._backend_name = "generic"
        self._model_path = str(getattr(s, "tts_model_path", "") or "")
        self._device = str(getattr(s, "tts_device", "cpu"))
        self._voice = str(getattr(s, "tts_voice", "") or "")
        self._speed = float(getattr(s, "tts_speed", 1.0) or 1.0)
        self._warmup = bool(getattr(s, "tts_warmup", True))
        self._torch_compile = bool(getattr(s, "tts_torch_compile", False))
        self._stream_default = bool(getattr(s, "tts_stream", False))
        self._idle_unload_sec = int(getattr(s, "tts_idle_unload_sec", 0))
        opts = getattr(s, "tts_opts", {}) or {}
        self._opts = dict(opts) if isinstance(opts, dict) else {}

        if self._loaded_key is not None and self._loaded_key != self._key():
            log.info("tts config changed — unloading current backend")
            await self.unload()

    @property
    def sample_rate(self) -> int:
        return self._backend.sample_rate if self._backend is not None else 24000

    @property
    def stream_default(self) -> bool:
        return self._stream_default

    # ── Load / unload ────────────────────────────────────────────────

    async def ensure_loaded(self) -> None:
        if self._backend is not None and self._loaded_key == self._key():
            return
        async with self._model_lock:
            if self._backend is not None and self._loaded_key == self._key():
                return
            if self._backend is not None:
                await self._do_unload_locked()
            await self._do_load_locked()

    async def _do_load_locked(self) -> None:
        model_id = self._effective_model()
        backend = resolve_tts_backend(model_id)
        log.info("tts loading backend=%s model=%s device=%s",
                 backend.name, model_id, self._device)
        self._status.last_error = ""
        self._status.running = False
        self._status.ready = False
        self._notify()

        cfg = TTSLoadConfig(
            model_id=model_id,
            device=self._device,
            warmup=self._warmup,
            torch_compile=self._torch_compile,
        )
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(self._exec, backend.load_sync, cfg)
            self._backend = backend
            self._backend_name = backend.name
            self._loaded_key = self._key()
            self._status.running = True
            self._status.ready = True
            self._last_used = time.monotonic()
            log.info("tts ready (backend=%s %s)", backend.name, backend.runtime_info())
            self._notify()
            self._ensure_idle_watcher()
        except Exception as exc:  # noqa: BLE001
            log.error("tts load failed: %s", exc)
            self._backend = None
            self._loaded_key = None
            self._status.running = False
            self._status.ready = False
            self._status.last_error = str(exc)
            self._notify()
            raise

    async def unload(self) -> None:
        async with self._model_lock:
            await self._do_unload_locked()

    async def _do_unload_locked(self) -> None:
        if self._backend is None:
            return
        log.info("tts unloading backend=%s", self._backend_name)
        be = self._backend
        self._backend = None
        self._loaded_key = None
        self._status.running = False
        self._status.ready = False
        self._notify()
        try:
            be.unload_sync()
        except Exception as exc:  # noqa: BLE001
            log.debug("tts unload exc (%s)", exc)

    # ── Synthesis ────────────────────────────────────────────────────

    def _build_opts(self, voice: str | None,
                     speed: float | None) -> tuple[str, dict[str, Any]]:
        """Resolve the per-call voice + return the family opts dict."""
        v = (voice or "").strip() if isinstance(voice, str) else ""
        if not v:
            v = self._effective_voice()
        else:
            # Per-call override — accept any catalog match, otherwise
            # fall back to the configured default.
            be = self._backend
            if be is not None:
                ids = be.voice_ids()
                if ids and v not in ids:
                    log.debug("tts: per-call voice %r unknown — using default", v)
                    v = self._effective_voice()
        # Speed only applies if the backend honours it.
        be = self._backend
        supports_speed = be.supports("speed") if be is not None else True
        spd = (float(speed) if (speed and speed > 0)
               else float(self._speed or 1.0))
        if not supports_speed:
            spd = 1.0
        # Per-call opts = configured family-specific opts + speed key.
        opts = dict(self._opts)
        opts["speed"] = spd
        # Filter against backend's runtime spec when available, so
        # stale keys from a different family don't leak through.
        if be is not None:
            specs = be.runtime_options()
            if specs:
                allowed = {"speed"} | {s.key for s in specs}
                opts = {k: opts[k] for k in opts if k in allowed}
        return v, opts

    async def synthesize(self, text: str,
                          voice: str | None = None,
                          speed: float | None = None) -> bytes:
        """Return WAV bytes (16-bit mono, backend's native sample rate)."""
        await self.ensure_loaded()
        assert self._backend is not None
        self._last_used = time.monotonic()
        v, opts = self._build_opts(voice, speed)
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(self._exec, self._collect_wav, text, v, opts)

    def _collect_wav(self, text: str, voice: str, opts: dict[str, Any]) -> bytes:
        """Drain the backend's sync chunk generator into a single WAV."""
        assert self._backend is not None
        parts: list[bytes] = []
        for chunk in self._backend.synth_chunks_sync(text, voice, opts):
            if chunk:
                parts.append(chunk)
        pcm = b"".join(parts)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(self._backend.sample_rate)
            wf.writeframes(pcm)
        return buf.getvalue()

    async def synthesize_pcm_chunks(
        self, text: str,
        voice: str | None = None,
        speed: float | None = None,
    ):
        """Async generator yielding raw int16 PCM chunks (mono).
        Server side wraps them in a chunked WAV response."""
        await self.ensure_loaded()
        assert self._backend is not None
        self._last_used = time.monotonic()
        v, opts = self._build_opts(voice, speed)

        loop = asyncio.get_event_loop()
        queue: asyncio.Queue = asyncio.Queue(maxsize=8)

        def _producer() -> None:
            try:
                assert self._backend is not None
                for chunk in self._backend.synth_chunks_sync(text, v, opts):
                    if not chunk:
                        continue
                    asyncio.run_coroutine_threadsafe(queue.put(chunk), loop).result()
            finally:
                asyncio.run_coroutine_threadsafe(queue.put(None), loop).result()

        loop.run_in_executor(self._exec, _producer)
        while True:
            chunk = await queue.get()
            if chunk is None:
                return
            yield chunk

    # ── Idle unload watcher ──────────────────────────────────────────

    def _ensure_idle_watcher(self) -> None:
        if self._idle_watch_started:
            return
        self._idle_watch_started = True

        def _loop_thread() -> None:
            INTERVAL = 30.0
            while True:
                time.sleep(INTERVAL)
                if self._backend is None:
                    continue
                if self._idle_unload_sec <= 0:
                    continue
                idle = time.monotonic() - (self._last_used or 0.0)
                if idle < self._idle_unload_sec:
                    continue
                log.info("tts idle for %.0fs ≥ %ds — unloading",
                         idle, self._idle_unload_sec)
                threading.Thread(
                    target=lambda: asyncio.run(self.unload()),
                    daemon=True,
                ).start()

        threading.Thread(target=_loop_thread, daemon=True,
                         name="voxtype-tts-idle").start()


# ── Module singleton ─────────────────────────────────────────────────

_ENGINE: TTSEngine | None = None


def get_engine() -> TTSEngine:
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = TTSEngine()
    return _ENGINE
