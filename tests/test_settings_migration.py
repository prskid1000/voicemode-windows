"""AppSettings.from_json should migrate old top-level keys into the
per-family opts bag without dropping user prefs."""
from __future__ import annotations

import unittest

from tests import _isolate  # noqa: F401
from voxtype.types import AppSettings


class StoredKeysMigration(unittest.TestCase):
    def test_old_stt_keys_move_to_opts(self):
        raw = {
            "stt_backend": "whisper",
            "stt_model_path": "openai/whisper-large-v3",
            "stt_task": "translate",
            "stt_num_beams": 4,
            "stt_initial_prompt": "VoxType, telecode, RouteMagic",
        }
        s = AppSettings.from_json(raw)
        # Old top-level family-specific keys gone, new opts populated.
        self.assertEqual(s.stt_opts.get("task"), "translate")
        self.assertEqual(s.stt_opts.get("num_beams"), 4)
        self.assertEqual(s.stt_opts.get("initial_prompt"),
                          "VoxType, telecode, RouteMagic")
        # Universal fields preserved.
        self.assertEqual(s.stt_model_path, "openai/whisper-large-v3")
        # Backend collapsed to generic.
        self.assertEqual(s.stt_backend, "generic")

    def test_old_tts_keys_move_to_opts(self):
        raw = {
            "tts_backend": "kokoro",
            "tts_model_path": "hexgrad/Kokoro-82M",
            "tts_speaker": "jm_kumo",
            "tts_length_scale": 1.25,
        }
        s = AppSettings.from_json(raw)
        # tts_speaker → tts_voice
        self.assertEqual(s.tts_voice, "jm_kumo")
        # tts_length_scale → tts_speed (top-level), not opts (we kept
        # speed as a universal-gated field).
        self.assertAlmostEqual(s.tts_speed, 1.25)
        # Backend collapsed.
        self.assertEqual(s.tts_backend, "generic")

    def test_new_format_round_trip(self):
        """Settings written with the new schema round-trip cleanly."""
        s1 = AppSettings()
        s1.stt_opts["task"] = "translate"
        s1.stt_opts["num_beams"] = 5
        s1.tts_opts["style"] = "Calm voice"
        s1.tts_voice = "af_heart"
        s1.tts_speed = 0.9
        s2 = AppSettings.from_json(s1.to_json())
        self.assertEqual(s2.stt_opts, s1.stt_opts)
        self.assertEqual(s2.tts_opts, s1.tts_opts)
        self.assertEqual(s2.tts_voice, s1.tts_voice)
        self.assertAlmostEqual(s2.tts_speed, s1.tts_speed)

    def test_unknown_legacy_keys_ignored(self):
        """Removed fields like stt_quant shouldn't blow up the loader."""
        raw = {"stt_quant": "int8", "stt_model_path": "foo/bar"}
        s = AppSettings.from_json(raw)  # must not raise
        self.assertEqual(s.stt_model_path, "foo/bar")

    def test_defaults_when_empty(self):
        s = AppSettings.from_json({})
        self.assertEqual(s.stt_backend, "generic")
        self.assertEqual(s.tts_backend, "generic")
        self.assertEqual(s.stt_opts, {})
        self.assertEqual(s.tts_opts, {})
        self.assertEqual(s.tts_voice, "af_heart")
        self.assertAlmostEqual(s.tts_speed, 1.0)


if __name__ == "__main__":
    unittest.main()
