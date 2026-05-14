"""Family detection: config.json blobs → STT/TTS family name."""
from __future__ import annotations

import unittest

from tests import _isolate  # noqa: F401  — sets VOXTYPE_DATA_DIR
from voxtype.backends import family_detect as fd


class STTFamilyFromConfig(unittest.TestCase):
    """Bare config.json `model_type` / `architectures` → STT family."""

    def _detect(self, cfg, repo=""):
        return fd._family_from_config(cfg, repo, stt=True)

    def test_whisper_by_model_type(self):
        self.assertEqual(
            self._detect({"model_type": "whisper"}, "openai/whisper-base"),
            fd.STT_WHISPER,
        )

    def test_whisper_by_repo_id(self):
        self.assertEqual(
            self._detect({}, "openai/whisper-large-v3-turbo"),
            fd.STT_WHISPER,
        )

    def test_wav2vec2_ctc(self):
        self.assertEqual(
            self._detect({"model_type": "wav2vec2"},
                          "facebook/wav2vec2-large-960h-lv60-self"),
            fd.STT_WAV2VEC2,
        )

    def test_hubert(self):
        self.assertEqual(
            self._detect({"model_type": "hubert"}),
            fd.STT_WAV2VEC2,
        )

    def test_mms_from_repo_id(self):
        # MMS is a wav2vec2-derivative; the family detector should pull
        # MMS specifically based on repo id substring.
        self.assertEqual(
            self._detect({"model_type": "wav2vec2"}, "facebook/mms-1b-all"),
            fd.STT_MMS,
        )

    def test_seamless(self):
        self.assertEqual(
            self._detect({"model_type": "seamless_m4t_v2"},
                          "facebook/seamless-m4t-v2-large"),
            fd.STT_SEAMLESS,
        )

    def test_moonshine(self):
        self.assertEqual(
            self._detect({"model_type": "moonshine"},
                          "UsefulSensors/moonshine-base"),
            fd.STT_MOONSHINE,
        )

    def test_speech_to_text(self):
        self.assertEqual(
            self._detect({"model_type": "speech_to_text"}),
            fd.STT_S2T,
        )

    def test_speecht5_asr_via_architectures(self):
        cfg = {
            "model_type": "speecht5",
            "architectures": ["SpeechT5ForSpeechToText"],
        }
        self.assertEqual(self._detect(cfg), fd.STT_SPEECHT5)

    def test_pipeline_tag_fallback(self):
        # No model_type, no architectures, just a pipeline_tag from
        # HF card metadata → generic.
        cfg = {"card": {"pipeline_tag": "automatic-speech-recognition"}}
        self.assertEqual(self._detect(cfg, "some/unknown-asr"), fd.STT_GENERIC)

    def test_unknown_returns_empty(self):
        self.assertEqual(self._detect({"model_type": "bert"}, "nlp/foo"), "")


class TTSFamilyFromConfig(unittest.TestCase):
    def _detect(self, cfg, repo=""):
        return fd._family_from_config(cfg, repo, stt=False)

    def test_kokoro_by_repo(self):
        self.assertEqual(
            self._detect({}, "hexgrad/Kokoro-82M"),
            fd.TTS_KOKORO,
        )

    def test_kokoro_local(self):
        # _kokoro_local marker emitted by _read_local_config when a
        # voices/ dir is present.
        self.assertEqual(
            self._detect({"_kokoro_local": True}, "/some/local/path"),
            fd.TTS_KOKORO,
        )

    def test_vits_by_model_type(self):
        self.assertEqual(
            self._detect({"model_type": "vits"}, "facebook/mms-tts-eng"),
            fd.TTS_VITS,
        )

    def test_mms_tts_by_repo(self):
        # facebook/mms-tts-* repos may use model_type=vits or not — both
        # paths should hit VITS.
        self.assertEqual(
            self._detect({}, "facebook/mms-tts-eng"),
            fd.TTS_VITS,
        )

    def test_speecht5_tts_via_architectures(self):
        cfg = {
            "model_type": "speecht5",
            "architectures": ["SpeechT5ForTextToSpeech"],
        }
        self.assertEqual(self._detect(cfg, "microsoft/speecht5_tts"),
                          fd.TTS_SPEECHT5)

    def test_bark(self):
        self.assertEqual(
            self._detect({"model_type": "bark"}, "suno/bark"),
            fd.TTS_BARK,
        )

    def test_parler(self):
        self.assertEqual(
            self._detect({}, "parler-tts/parler-tts-mini-v1"),
            fd.TTS_PARLER,
        )

    def test_generic_via_pipeline_tag(self):
        cfg = {"card": {"pipeline_tag": "text-to-speech"}}
        self.assertEqual(
            self._detect(cfg, "some/unknown-tts"),
            fd.TTS_GENERIC,
        )


class CapabilitiesAndOptions(unittest.TestCase):
    """Each family should advertise a sensible cap set + option list."""

    def test_whisper_caps(self):
        caps = fd.stt_capabilities(fd.STT_WHISPER)
        for needed in ("multilingual", "task_translate", "initial_prompt",
                        "num_beams", "dtype", "torch_compile"):
            self.assertIn(needed, caps, f"whisper should advertise {needed!r}")

    def test_wav2vec2_caps_minimal(self):
        # CTC family has no language/beams/prompt — only dtype + compile.
        caps = fd.stt_capabilities(fd.STT_WAV2VEC2)
        self.assertIn("dtype", caps)
        self.assertIn("torch_compile", caps)
        self.assertNotIn("task_translate", caps)
        self.assertNotIn("initial_prompt", caps)
        self.assertNotIn("multilingual", caps)
        self.assertNotIn("num_beams", caps)

    def test_mms_multilingual(self):
        caps = fd.stt_capabilities(fd.STT_MMS)
        self.assertIn("multilingual", caps)

    def test_kokoro_streams(self):
        self.assertIn("stream", fd.tts_capabilities(fd.TTS_KOKORO))
        self.assertIn("speed", fd.tts_capabilities(fd.TTS_KOKORO))

    def test_parler_has_style_prompt(self):
        caps = fd.tts_capabilities(fd.TTS_PARLER)
        self.assertIn("style_prompt", caps)

    def test_whisper_option_keys(self):
        keys = {o.key for o in fd.stt_runtime_options(fd.STT_WHISPER)}
        self.assertEqual(keys, {"task", "num_beams", "initial_prompt"})

    def test_wav2vec2_no_options(self):
        self.assertEqual(fd.stt_runtime_options(fd.STT_WAV2VEC2), [])

    def test_parler_options(self):
        keys = {o.key for o in fd.tts_runtime_options(fd.TTS_PARLER)}
        self.assertIn("style", keys)

    def test_bark_options(self):
        keys = {o.key for o in fd.tts_runtime_options(fd.TTS_BARK)}
        self.assertIn("temperature", keys)

    def test_speecht5_options(self):
        keys = {o.key for o in fd.tts_runtime_options(fd.TTS_SPEECHT5)}
        self.assertIn("speaker_embedding", keys)

    def test_family_labels_present(self):
        # Every detected family should have a human-readable label.
        for fam in (fd.STT_WHISPER, fd.STT_WAV2VEC2, fd.STT_MMS,
                     fd.STT_SEAMLESS, fd.STT_MOONSHINE):
            self.assertTrue(fd.stt_family_label(fam),
                             f"missing STT label for {fam!r}")
        for fam in (fd.TTS_KOKORO, fd.TTS_VITS, fd.TTS_SPEECHT5,
                     fd.TTS_BARK, fd.TTS_PARLER):
            self.assertTrue(fd.tts_family_label(fam),
                             f"missing TTS label for {fam!r}")


if __name__ == "__main__":
    unittest.main()
