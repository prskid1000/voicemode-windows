"""STT — thin shim around the in-process engine.

`transcribe()` delegates to `stt_engine.STTEngine` which runs ONNX-based
STT directly in our process.

`pcm_to_wav()` is kept because the main pipeline still uses it for
history clipping / debugging. Audio for STT itself goes straight to
the engine as raw int16 PCM.
"""
from __future__ import annotations

import logging
import struct

log = logging.getLogger("voxtype.stt")

SAMPLE_RATE = 16000
CHANNELS = 1
BYTES_PER_SAMPLE = 2  # int16


def pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE,
               channels: int = CHANNELS) -> bytes:
    """Wrap raw 16-bit PCM in a minimal WAV header.

    Still useful for diagnostics / save-history-as-wav workflows even
    though the engine itself takes raw PCM."""
    data_size = len(pcm)
    byte_rate = sample_rate * channels * BYTES_PER_SAMPLE
    block_align = channels * BYTES_PER_SAMPLE
    header = b"".join([
        b"RIFF",
        struct.pack("<I", 36 + data_size),
        b"WAVE",
        b"fmt ",
        struct.pack("<IHHIIHH", 16, 1, channels, sample_rate,
                    byte_rate, block_align, BYTES_PER_SAMPLE * 8),
        b"data",
        struct.pack("<I", data_size),
    ])
    return header + pcm


def silent_wav() -> bytes:
    """100 ms of silence. Used to preload the STT model."""
    n = SAMPLE_RATE // 10
    return pcm_to_wav(b"\x00\x00" * n)


async def transcribe(pcm: bytes, *_legacy_args,
                      language: str = "en",
                      timeout: float = 45.0,
                      **_legacy_kwargs) -> str:
    """Transcribe `pcm` (raw 16 kHz mono int16) and return the text.

    `*_legacy_args` / `**_legacy_kwargs` swallow any leftover positional
    URLs / kwargs from older call sites.
    """
    from voxtype.stt_engine import get_engine
    return await get_engine().transcribe(pcm, language=language)


async def preload(*_legacy_args, **_legacy_kwargs) -> None:
    """Warm up the STT model. Swallows errors — preload is best-effort."""
    from voxtype.stt_engine import get_engine
    try:
        await get_engine().ensure_loaded()
        log.info("stt preloaded")
    except Exception as exc:
        log.info("stt preload failed (non-fatal): %s", exc)
