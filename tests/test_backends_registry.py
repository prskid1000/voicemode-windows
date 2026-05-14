"""Registry should expose exactly the generic STT + TTS backends and
resolve any model id to them."""
from __future__ import annotations

import unittest

from tests import _isolate  # noqa: F401


class Registry(unittest.TestCase):
    def test_stt_registry_names(self):
        from voxtype.backends import stt_backend_names
        self.assertEqual(stt_backend_names(), ["generic"])

    def test_tts_registry_names(self):
        from voxtype.backends import tts_backend_names
        self.assertEqual(tts_backend_names(), ["generic"])

    def test_get_stt_default(self):
        from voxtype.backends import get_stt_backend
        be = get_stt_backend()
        self.assertEqual(type(be).__name__, "GenericSTTBackend")

    def test_get_tts_default(self):
        from voxtype.backends import get_tts_backend
        be = get_tts_backend()
        self.assertEqual(type(be).__name__, "GenericTTSBackend")

    def test_resolve_for_any_model_id(self):
        from voxtype.backends import resolve_stt_backend, resolve_tts_backend
        # Whisper, Wav2Vec2, MMS, Seamless, Moonshine all resolve to
        # the same generic backend — dispatch is internal.
        for mid in ("openai/whisper-base",
                     "facebook/wav2vec2-large-960h",
                     "facebook/mms-1b-all",
                     "facebook/seamless-m4t-v2-large",
                     "UsefulSensors/moonshine-base",
                     "random/unknown-model"):
            be = resolve_stt_backend(mid)
            self.assertEqual(type(be).__name__, "GenericSTTBackend",
                              f"stt resolve failed for {mid}")
        for mid in ("hexgrad/Kokoro-82M",
                     "facebook/mms-tts-eng",
                     "microsoft/speecht5_tts",
                     "suno/bark",
                     "parler-tts/parler-tts-mini-v1"):
            be = resolve_tts_backend(mid)
            self.assertEqual(type(be).__name__, "GenericTTSBackend",
                              f"tts resolve failed for {mid}")


class GenericBackendShape(unittest.TestCase):
    """The generic backends should advertise no family / no options
    pre-load, and accept any model id via can_handle."""

    def test_stt_pre_load(self):
        from voxtype.backends import get_stt_backend
        be = get_stt_backend()
        self.assertEqual(be.detected_family(), "")
        self.assertEqual(be.runtime_options(), [])
        self.assertEqual(be.name, "generic")
        # Universal fallback never claims a feature pre-load.
        self.assertFalse(be.supports("task_translate"))

    def test_tts_pre_load(self):
        from voxtype.backends import get_tts_backend
        be = get_tts_backend()
        self.assertEqual(be.detected_family(), "")
        self.assertEqual(be.runtime_options(), [])
        # Voice catalog is empty pre-load (handler not built yet).
        self.assertEqual(be.voices(), [])


if __name__ == "__main__":
    unittest.main()
