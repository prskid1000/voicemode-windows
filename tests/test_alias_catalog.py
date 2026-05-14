"""voxtype/resources/models.json should ship a sane catalog and the
loader should expose it via settings_window._load_aliases()."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from tests import _isolate  # noqa: F401


CATALOG = Path(__file__).resolve().parent.parent / "voxtype" / "resources" / "models.json"


class CatalogFile(unittest.TestCase):
    def test_catalog_exists(self):
        self.assertTrue(CATALOG.exists(),
                         f"missing catalog file: {CATALOG}")

    def test_catalog_parses(self):
        data = json.loads(CATALOG.read_text(encoding="utf-8"))
        self.assertIn("stt", data)
        self.assertIn("tts", data)
        self.assertIsInstance(data["stt"], list)
        self.assertIsInstance(data["tts"], list)
        self.assertGreaterEqual(len(data["stt"]), 8)
        self.assertGreaterEqual(len(data["tts"]), 6)

    def test_every_entry_has_name_and_model(self):
        data = json.loads(CATALOG.read_text(encoding="utf-8"))
        for kind in ("stt", "tts"):
            for entry in data[kind]:
                self.assertIn("name", entry, f"{kind} entry missing name: {entry}")
                self.assertIn("model", entry, f"{kind} entry missing model: {entry}")
                self.assertTrue(entry["name"])
                self.assertTrue("/" in entry["model"],
                                 f"model should be a HF repo id: {entry}")

    def test_catalog_covers_each_family(self):
        """The curated catalog should expose at least one entry per
        major family, so the model picker is useful out of the box."""
        from voxtype.backends import family_detect as fd
        data = json.loads(CATALOG.read_text(encoding="utf-8"))
        stt_families: set[str] = set()
        for entry in data["stt"]:
            fam = fd._family_from_config({}, entry["model"], stt=True)
            if fam:
                stt_families.add(fam)
        # By repo-id heuristics we should hit at least whisper +
        # one of {wav2vec2, mms, seamless, moonshine}.
        self.assertIn(fd.STT_WHISPER, stt_families)
        self.assertTrue(stt_families & {fd.STT_WAV2VEC2, fd.STT_MMS,
                                         fd.STT_SEAMLESS, fd.STT_MOONSHINE},
                         f"catalog has no non-whisper STT entries: {stt_families}")

        tts_families: set[str] = set()
        for entry in data["tts"]:
            fam = fd._family_from_config({}, entry["model"], stt=False)
            if fam:
                tts_families.add(fam)
        self.assertIn(fd.TTS_KOKORO, tts_families)
        self.assertTrue(tts_families & {fd.TTS_VITS, fd.TTS_BARK,
                                         fd.TTS_PARLER},
                         f"catalog has only kokoro TTS entries: {tts_families}")


if __name__ == "__main__":
    unittest.main()
