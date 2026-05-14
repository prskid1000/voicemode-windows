"""STT engine orchestrator — owns lifecycle, delegates to a backend.

The actual transcription work is done by a swappable
`voxtype.backends.STTBackend` instance (the generic backend in
normal use). This module handles:
  - load / unload locking
  - idle-unload watcher
  - status listeners
  - rebuild-on-config-change via `_key()`

Per-family options live in `settings.stt_opts` (a free-form dict) so
backends can introduce new family-specific knobs without ever needing
to add a top-level AppSettings field.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable

from voxtype.backends import (
    get_stt_backend, resolve_stt_backend, stt_backend_names,
)
from voxtype.backends.shared import WHISPER_LANGUAGES
from voxtype.backends.stt_base import LoadConfig, STTBackend

log = logging.getLogger("voxtype.stt_engine")


# Re-export for callers that read `DEFAULT_MODEL` / language helpers.
DEFAULT_MODEL = "openai/whisper-base"
LANGUAGES = WHISPER_LANGUAGES


def all_language_codes() -> set[str]:
    return {c for c, _ in LANGUAGES}


def language_combo_options() -> list[tuple[str, str]]:
    return [
        (code, name if code == "auto" else f"{code} — {name}")
        for code, name in LANGUAGES
    ]


def available_backends() -> list[str]:
    """Names of STT backends that imported successfully."""
    return stt_backend_names()


@dataclass
class EngineStatus:
    running: bool = False
    ready: bool = False
    pid: int | None = None
    last_error: str = ""
    backend: str = ""
    family: str = ""

    @property
    def name(self) -> str:
        return "stt"


class STTEngine:
    """Singleton — call `get_engine()`. Thread-safe."""

    def __init__(self) -> None:
        self._backend: STTBackend | None = None
        self._backend_name: str = ""
        self._model_lock = asyncio.Lock()
        self._exec = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voxtype-stt")
        self._loaded_key: tuple | None = None
        self._status = EngineStatus()
        self._listeners: list[Callable[[EngineStatus], None]] = []
        self._last_used = 0.0
        self._idle_unload_sec = 0
        self._idle_watch_started = False

        # Current settings snapshot.
        self._model_path = ""
        self._device = "cpu"
        self._language = "en"
        self._dtype_pref = "auto"
        self._warmup = True
        self._torch_compile = False
        self._opts: dict[str, Any] = {}

    # ── Listener wiring ──────────────────────────────────────────────

    def on_status_change(self, fn: Callable[[EngineStatus], None]) -> None:
        self._listeners.append(fn)

    def get_status(self) -> EngineStatus:
        family = ""
        if self._backend is not None:
            try:
                family = self._backend.detected_family() or ""
            except Exception:
                family = ""
        return EngineStatus(
            running=self._status.running,
            ready=self._status.ready,
            pid=None,
            last_error=self._status.last_error,
            backend=self._backend_name,
            family=family,
        )

    def get_backend(self) -> STTBackend | None:
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
            return self._backend.default_model or DEFAULT_MODEL
        return DEFAULT_MODEL

    def _key(self) -> tuple:
        # Fields that require a model rebuild. Per-call kwargs (language,
        # task, beams, prompt) are NOT in here.
        return (
            "generic",
            self._effective_model(), self._device,
            self._dtype_pref, bool(self._torch_compile),
        )

    async def configure(self, s) -> None:
        self._backend_name = "generic"
        self._model_path = str(getattr(s, "stt_model_path", "") or "")
        self._device = str(getattr(s, "stt_device", "cpu"))
        self._language = str(getattr(s, "stt_language", "en") or "en")
        self._dtype_pref = str(getattr(s, "stt_dtype", "auto") or "auto")
        self._warmup = bool(getattr(s, "stt_warmup", True))
        self._torch_compile = bool(getattr(s, "stt_torch_compile", False))
        self._idle_unload_sec = int(getattr(s, "stt_idle_unload_sec", 0))
        opts = getattr(s, "stt_opts", {}) or {}
        self._opts = dict(opts) if isinstance(opts, dict) else {}

        if self._loaded_key is not None and self._loaded_key != self._key():
            log.info("stt config changed — unloading current backend")
            await self.unload()

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
        backend = resolve_stt_backend(model_id)
        log.info("stt loading backend=%s model=%s device=%s",
                 backend.name, model_id, self._device)
        self._status.last_error = ""
        self._status.running = False
        self._status.ready = False
        self._notify()

        cfg = LoadConfig(
            model_id=model_id,
            device=self._device,
            dtype=self._dtype_pref,
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
            log.info("stt ready (backend=%s %s)", backend.name, backend.runtime_info())
            self._notify()
            self._ensure_idle_watcher()
        except Exception as exc:  # noqa: BLE001
            log.error("stt load failed: %s", exc)
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
        log.info("stt unloading backend=%s", self._backend_name)
        be = self._backend
        self._backend = None
        self._loaded_key = None
        self._status.running = False
        self._status.ready = False
        self._notify()
        try:
            be.unload_sync()
        except Exception as exc:  # noqa: BLE001
            log.debug("stt unload exc (%s)", exc)

    # ── Transcription ────────────────────────────────────────────────

    def _build_opts(self, language: str | None) -> dict[str, Any]:
        """Per-call opts dict assembled from settings + filtered against
        the backend's `supports()` flags. The universal `language` is
        always passed through; family-specific opts (task, num_beams,
        initial_prompt, etc.) are filtered out for backends that don't
        honour them so a stale stt_opts entry can't confuse a different
        family."""
        backend = self._backend
        lang = (language or self._language or "en").strip() or "en"
        out: dict[str, Any] = {"language": lang}
        if not backend:
            return out
        # Forward only the family-relevant subset.
        specs = backend.runtime_options() if hasattr(backend, "runtime_options") else []
        allowed = {s.key for s in specs}
        for k, v in self._opts.items():
            if k in allowed:
                out[k] = v
        return out

    async def transcribe(self, pcm: bytes, language: str | None = None) -> str:
        """Run STT on raw 16 kHz mono int16 PCM. Returns the text."""
        await self.ensure_loaded()
        self._last_used = time.monotonic()
        assert self._backend is not None
        opts = self._build_opts(language)
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            self._exec, self._backend.transcribe_sync, pcm, opts,
        )

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
                log.info("stt idle for %.0fs ≥ %ds — unloading",
                         idle, self._idle_unload_sec)
                threading.Thread(
                    target=lambda: asyncio.run(self.unload()),
                    daemon=True,
                ).start()

        threading.Thread(target=_loop_thread, daemon=True,
                         name="voxtype-stt-idle").start()


# ── Module singleton ─────────────────────────────────────────────────

_ENGINE: STTEngine | None = None


def get_engine() -> STTEngine:
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = STTEngine()
    return _ENGINE
