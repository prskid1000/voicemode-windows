"""Raw 16 kHz mono int16 PCM recorder built on sounddevice.

Start recording when the hotkey activates, stop + return the buffer
when it releases. Runs on sounddevice's own callback thread.

Optional auto-stop-on-silence: if `silence_duration` is set, the
recorder measures RMS energy per callback frame and fires
`on_silence_timeout` after that many seconds of continuous quiet
(counted only after the first speech frame — prevents insta-stop on
a silent mic). The callback runs on a short worker thread so PortAudio's
own thread is never blocked.
"""
from __future__ import annotations

import collections
import logging
import threading
import time
from typing import Callable

import numpy as np
import sounddevice as sd

log = logging.getLogger("voxtype.audio")

SAMPLE_RATE = 16000
CHANNELS = 1

# RMS below this is treated as silence (per-frame, ≈10–30 ms). Same
# threshold as voxtype/vad.py.
_SILENCE_RMS = 100.0

# Reference RMS for normalising the live level meter to 0..1. Picked so
# normal-conversation int16 RMS (~1500–4000) maps comfortably into the
# visible bar range; loud speech saturates at 1.0.
_LEVEL_REF = 4000.0
# Number of recent per-callback RMS samples kept for the waveform.
_LEVEL_RING = 11


class Recorder:
    def __init__(self) -> None:
        self._chunks: list[bytes] = []
        self._lock = threading.Lock()
        self._stream: sd.InputStream | None = None

        # Auto-stop state
        self._silence_duration: float = 0.0
        self._on_silence_cb: Callable[[], None] | None = None
        self._silence_start: float | None = None
        self._had_speech: bool = False

        # Live audio-level ring for the recording-state waveform. Pushed
        # from PortAudio's callback thread, read from the Qt thread.
        self._levels: collections.deque[float] = collections.deque(maxlen=_LEVEL_RING)
        self._levels_lock = threading.Lock()

    def start(self,
              silence_duration: float = 0.0,
              on_silence: Callable[[], None] | None = None) -> None:
        """Open the input stream. No-op if already recording.

        Args:
            silence_duration: seconds of continuous silence before
                `on_silence` fires. 0 disables auto-stop.
            on_silence: called from a worker thread (NOT PortAudio's
                callback thread) when silence has persisted after at
                least one speech frame was seen. Typically the caller's
                handler that invokes self.stop() + runs the pipeline.
        """
        if self._stream is not None:
            return
        self._chunks.clear()
        self._silence_duration = max(0.0, float(silence_duration))
        self._on_silence_cb = on_silence
        self._silence_start = None
        self._had_speech = False
        with self._levels_lock:
            self._levels.clear()
        fired = {"done": False}

        def _callback(indata, frames, time_info, status):
            if status:
                log.debug("audio status: %s", status)
            pcm = (np.clip(indata[:, 0], -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
            with self._lock:
                self._chunks.append(pcm)

            samples = np.frombuffer(pcm, dtype=np.int16)
            rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))) if samples.size else 0.0
            with self._levels_lock:
                self._levels.append(min(1.0, rms / _LEVEL_REF))

            if self._silence_duration <= 0 or self._on_silence_cb is None or fired["done"]:
                return

            now = time.monotonic()
            if rms > _SILENCE_RMS:
                self._had_speech = True
                self._silence_start = None
            else:
                if not self._had_speech:
                    return
                if self._silence_start is None:
                    self._silence_start = now
                elif (now - self._silence_start) >= self._silence_duration:
                    fired["done"] = True
                    cb = self._on_silence_cb
                    if cb is not None:
                        threading.Thread(target=cb, daemon=True,
                                         name="voxtype-silence-cb").start()

        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE, channels=CHANNELS,
            dtype="float32", callback=_callback,
        )
        self._stream.start()

    def stop(self) -> bytes:
        """Close the stream and return the captured PCM. Empty bytes
        if nothing was recorded."""
        if self._stream is None:
            return b""
        try:
            self._stream.stop()
            self._stream.close()
        except Exception as exc:
            log.warning("stopping stream: %s", exc)
        self._stream = None
        with self._lock:
            data = b"".join(self._chunks)
            self._chunks.clear()
        self._on_silence_cb = None
        return data

    @property
    def recording(self) -> bool:
        return self._stream is not None

    def levels(self) -> list[float]:
        """Snapshot of recent normalised RMS levels (oldest → newest).

        Each entry is one PortAudio callback's RMS divided by `_LEVEL_REF`,
        clipped to [0, 1]. Safe to call from any thread; returns an empty
        list before the first callback."""
        with self._levels_lock:
            return list(self._levels)
