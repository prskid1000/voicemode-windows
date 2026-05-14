"""Engines should pass only family-relevant opts to the backend so a
stale stt_opts entry can't confuse a different family."""
from __future__ import annotations

import unittest

from tests import _isolate  # noqa: F401


class FakeBackend:
    """Stand-in for a loaded backend that advertises a fixed runtime
    spec; the engine should filter opts against this."""
    def __init__(self, spec_keys):
        from voxtype.backends.stt_base import OptionSpec
        self._specs = [OptionSpec(k, "str", k, "") for k in spec_keys]

    def runtime_options(self):
        return self._specs


class STTOptsFilter(unittest.TestCase):
    def test_filters_to_allowed_keys(self):
        from voxtype.stt_engine import STTEngine
        eng = STTEngine()
        eng._backend = FakeBackend(["task", "num_beams"])
        eng._language = "en"
        eng._opts = {
            "task": "translate",
            "num_beams": 5,
            "initial_prompt": "stale value",
            "temperature": 0.7,  # belongs to a different family
        }
        opts = eng._build_opts(None)
        # `language` is always passed through (universal field).
        self.assertEqual(opts["language"], "en")
        self.assertEqual(opts["task"], "translate")
        self.assertEqual(opts["num_beams"], 5)
        # `initial_prompt` not advertised → filtered out.
        self.assertNotIn("initial_prompt", opts)
        self.assertNotIn("temperature", opts)

    def test_no_backend_yields_just_language(self):
        from voxtype.stt_engine import STTEngine
        eng = STTEngine()
        eng._backend = None
        eng._language = "es"
        opts = eng._build_opts(None)
        self.assertEqual(opts, {"language": "es"})

    def test_per_call_language_overrides_default(self):
        from voxtype.stt_engine import STTEngine
        eng = STTEngine()
        eng._backend = None
        eng._language = "en"
        opts = eng._build_opts("fr")
        self.assertEqual(opts["language"], "fr")


if __name__ == "__main__":
    unittest.main()
