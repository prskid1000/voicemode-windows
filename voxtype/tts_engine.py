"""Direct in-process TTS inference via ONNX Runtime.

Pass an `.onnx` + `.onnx.json` pair to the engine and it does the rest.
Any compatible TTS model works (the loaded file IS the voice).

Model source: local file path OR a HuggingFace repo ID, which is auto-
downloaded via `huggingface_hub` on first load.

CPU / GPU switching is purely an ONNX Runtime concern — `device='cuda'`
falls back to CPU automatically if onnxruntime-gpu isn't usable.

Lifecycle, status callbacks and idle unload mirror stt_engine.py so
the tray + settings UI use the same code paths.
"""
from __future__ import annotations

import asyncio
import gc
import io
import json
import logging
import struct
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("voxtype.tts_engine")


# ── Status type (mirrors stt_engine.EngineStatus) ────────────────────

@dataclass
class TTSStatus:
    running: bool = False
    ready: bool = False
    pid: int | None = None
    last_error: str = ""

    @property
    def name(self) -> str:
        return "tts"


class TTSEngine:
    """Singleton — call `get_engine()`. Thread-safe."""

    def __init__(self) -> None:
        self._voice: Any = None         # PiperVoice wrapper (when piper-tts is installed)
        self._session: Any = None       # raw onnxruntime.InferenceSession (fallback path)
        self._model_lock = asyncio.Lock()
        self._exec = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voxtype-tts")
        self._loaded_key: tuple | None = None
        self._status = TTSStatus()
        self._listeners: list[Callable[[TTSStatus], None]] = []
        self._last_used = 0.0
        self._idle_unload_sec = 0
        self._idle_watch_started = False
        self._sample_rate = 22050     # overridden when the model loads

        # Current settings.
        self._model_path = ""
        self._device = "cpu"
        self._speaker = 0
        self._length_scale = 1.0
        self._noise_scale = 0.667
        self._noise_w = 0.8

    # ── Listener wiring ──────────────────────────────────────────────

    def on_status_change(self, fn: Callable[[TTSStatus], None]) -> None:
        self._listeners.append(fn)

    def get_status(self) -> TTSStatus:
        return TTSStatus(
            running=self._status.running,
            ready=self._status.ready,
            pid=None,
            last_error=self._status.last_error,
        )

    def _notify(self) -> None:
        for fn in list(self._listeners):
            try:
                fn(self.get_status())
            except Exception:
                pass

    # ── Configuration ────────────────────────────────────────────────

    def _key(self) -> tuple:
        return (self._model_path, self._device)

    async def configure(self, s) -> None:
        self._model_path = str(getattr(s, "tts_model_path", "") or "")
        self._device = getattr(s, "tts_device", "cpu")
        self._speaker = int(getattr(s, "tts_speaker", 0))
        self._length_scale = float(getattr(s, "tts_length_scale", 1.0))
        self._noise_scale = float(getattr(s, "tts_noise_scale", 0.667))
        self._noise_w = float(getattr(s, "tts_noise_w", 0.8))
        self._idle_unload_sec = int(getattr(s, "tts_idle_unload_sec", 0))

        if self._loaded_key is not None and self._loaded_key != self._key():
            log.info("tts config changed — unloading current model")
            await self.unload()

    # ── Load / unload ────────────────────────────────────────────────

    async def ensure_loaded(self) -> None:
        if not self._model_path:
            raise RuntimeError("tts_model_path is empty — set it in Settings")
        if self._voice is not None and self._loaded_key == self._key():
            return
        async with self._model_lock:
            if self._voice is not None and self._loaded_key == self._key():
                return
            if self._voice is not None:
                await self._do_unload_locked()
            await self._do_load_locked()

    async def _do_load_locked(self) -> None:
        # Resolve model path: local file/dir OR HuggingFace repo ID.
        try:
            resolved = _resolve_tts_model(self._model_path)
        except Exception as exc:
            self._status.last_error = str(exc)
            self._notify()
            raise
        log.info("tts loading model=%s device=%s", resolved, self._device)
        path = resolved
        self._status.last_error = ""
        self._status.running = False
        self._status.ready = False
        self._notify()
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(self._exec, self._build_voice, str(path))
            self._loaded_key = self._key()
            self._status.running = True
            self._status.ready = True
            self._last_used = time.monotonic()
            log.info("tts ready (sample_rate=%d)", self._sample_rate)
            self._notify()
            self._ensure_idle_watcher()
        except Exception as exc:
            log.error("tts load failed: %s", exc)
            self._voice = None
            self._session = None
            self._loaded_key = None
            self._status.running = False
            self._status.ready = False
            self._status.last_error = str(exc)
            self._notify()
            raise

    def _providers(self) -> list[str]:
        """ONNX Runtime execution providers, ordered for natural CPU fallback."""
        if self._device == "cuda":
            return ["CUDAExecutionProvider", "CPUExecutionProvider"]
        return ["CPUExecutionProvider"]

    def _build_voice(self, path: str) -> None:
        """Sync — runs in the executor. Loads the voice via `piper-tts`
        if available (bundles phonemization); falls back to raw
        onnxruntime if not."""
        providers = self._providers()
        try:
            from piper import PiperVoice  # type: ignore
            self._voice = PiperVoice.load(path, use_cuda=(self._device == "cuda"))
            cfg_path = Path(path).with_suffix(Path(path).suffix + ".json")
            if cfg_path.exists():
                try:
                    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
                    self._sample_rate = int(cfg.get("audio", {}).get("sample_rate", 22050))
                except Exception:
                    pass
            return
        except ImportError:
            log.info("piper-tts not installed — falling back to raw onnxruntime")
        # Raw onnxruntime path. Limited: only supports models whose JSON
        # config bundles the phoneme map AND callers pass phoneme IDs.
        # For now we just open the session and load the JSON; phonemization
        # without piper-tts is out of scope (users should install piper-tts).
        import onnxruntime as ort
        self._session = ort.InferenceSession(path, providers=providers)
        cfg_path = Path(path).with_suffix(Path(path).suffix + ".json")
        if cfg_path.exists():
            try:
                cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
                self._sample_rate = int(cfg.get("audio", {}).get("sample_rate", 22050))
            except Exception:
                pass

    async def unload(self) -> None:
        async with self._model_lock:
            await self._do_unload_locked()

    async def _do_unload_locked(self) -> None:
        if self._voice is None and self._session is None:
            return
        log.info("tts unloading")
        self._voice = None
        self._session = None
        self._loaded_key = None
        self._status.running = False
        self._status.ready = False
        self._notify()
        gc.collect()

    # ── Synthesis ────────────────────────────────────────────────────

    async def synthesize(self, text: str,
                          voice: str | None = None,
                          speed: float | None = None) -> bytes:
        """Return WAV bytes (16-bit mono) for `text`. `voice` is accepted
        for OpenAI-shape API compatibility but ignored — the loaded
        model IS the voice."""
        await self.ensure_loaded()
        self._last_used = time.monotonic()
        # OpenAI speed (1.0 = normal) → length_scale (inverse).
        if speed is None or speed <= 0:
            length_scale = self._length_scale
        else:
            length_scale = self._length_scale / float(speed)
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            self._exec, self._do_synthesize, text, length_scale,
        )

    def _do_synthesize(self, text: str, length_scale: float) -> bytes:
        """Sync — runs in the executor. Returns WAV bytes."""
        if self._voice is not None:
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(self._sample_rate)
                # piper-tts API has varied across versions — support both
                # the "synthesize" generator method and the
                # "synthesize_to_wav_file" file-writer fallback.
                synth_args = dict(
                    speaker_id=self._speaker,
                    length_scale=length_scale,
                    noise_scale=self._noise_scale,
                    noise_w=self._noise_w,
                )
                try:
                    self._voice.synthesize(text, wf, **synth_args)
                except TypeError:
                    # Older API: passes the wave file as positional.
                    self._voice.synthesize(text, wav_file=wf, **synth_args)
            return buf.getvalue()
        raise RuntimeError(
            "tts model loaded via raw onnxruntime — install `piper-tts` "
            "for text synthesis support"
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
                if self._voice is None and self._session is None:
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


# ── Model resolver ───────────────────────────────────────────────────

def _resolve_tts_model(model_path: str) -> Path:
    """Accept either a local path or a HuggingFace repo ID.

    Returns a local `Path` to the `.onnx` file. If the input is an HF
    repo ID, snapshot_download fetches it to the HF cache and we pick
    the first `.onnx` file inside.
    """
    if not model_path:
        raise RuntimeError("tts_model_path is empty — set it in Settings")
    p = Path(model_path).expanduser()
    if p.exists():
        if p.is_file():
            return p
        # Directory → first .onnx inside.
        for child in p.rglob("*.onnx"):
            if not child.name.endswith(".onnx.json"):
                return child
        raise RuntimeError(f"no .onnx file under {p}")
    # Looks like an HF repo? (contains '/', not absolute)
    if "/" in model_path and not p.is_absolute():
        try:
            from huggingface_hub import snapshot_download
        except ImportError as exc:
            raise RuntimeError(
                "huggingface_hub not installed — `pip install huggingface_hub` "
                "or enter a local path to the .onnx file"
            ) from exc
        log.info("tts downloading HF repo %s …", model_path)
        cached = Path(snapshot_download(repo_id=model_path))
        for child in cached.rglob("*.onnx"):
            if not child.name.endswith(".onnx.json"):
                return child
        raise RuntimeError(f"no .onnx file in HF repo {model_path}")
    raise RuntimeError(f"model not found: {model_path}")


# ── Module singleton ─────────────────────────────────────────────────

_ENGINE: TTSEngine | None = None


def get_engine() -> TTSEngine:
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = TTSEngine()
    return _ENGINE
