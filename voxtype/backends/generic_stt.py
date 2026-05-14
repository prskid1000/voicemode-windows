"""Generic STT backend — one backend, many model families.

Paste any HuggingFace repo id (or local path); this backend sniffs the
model's `config.json`, picks the right transformers loader class, and
exposes the right per-family runtime options. Families covered:

  whisper        → WhisperForConditionalGeneration   (full knob set)
  wav2vec2       → Wav2Vec2ForCTC + AutoProcessor    (CTC, single lang)
  mms            → Wav2Vec2ForCTC + lang adapter     (1107 langs)
  seamless       → SeamlessM4Tv2 / SeamlessM4T S2T
  moonshine      → MoonshineForConditionalGeneration (English, fast)
  speech_to_text → Speech2TextForConditionalGeneration
  speecht5_asr   → SpeechT5ForSpeechToText
  parakeet       → NeMo TDT/RNNT via HF mirror
  qwen_audio     → Qwen2-Audio multimodal LLM
  generic_asr    → transformers.pipeline("automatic-speech-recognition")
                   — universal fallback covering everything else

Any family the user's transformers install doesn't know about falls
through to the generic pipeline, which itself can handle anything HF
registers as an ASR model.
"""
from __future__ import annotations

import gc
import logging
from typing import Any

import numpy as np

from voxtype.backends import family_detect as fd
from voxtype.backends.stt_base import LoadConfig, STTBackend, OptionSpec

log = logging.getLogger("voxtype.backends.generic_stt")


# ── Per-family handlers ──────────────────────────────────────────────
# Each handler owns its own model + processor pair. The dispatcher
# below picks the right one based on the detected family.


class _BaseHandler:
    family: str = ""

    def __init__(self) -> None:
        self._model: Any = None
        self._processor: Any = None
        self._torch_device: str = "cpu"
        self._torch_dtype: Any = None

    @staticmethod
    def _pick_dtype(pref: str, on_cuda: bool):
        import torch
        pref = (pref or "auto").lower()
        if pref == "auto":
            return torch.float16 if on_cuda else torch.float32
        if pref == "fp16":
            return torch.float16 if on_cuda else torch.float32
        if pref == "bf16":
            return torch.bfloat16
        return torch.float32

    def _resolve_device(self, cfg: LoadConfig) -> bool:
        import torch
        on_cuda = cfg.device == "cuda" and torch.cuda.is_available()
        if cfg.device == "cuda" and not on_cuda:
            log.warning("%s: cuda requested but unavailable — using CPU", self.family)
        self._torch_device = "cuda" if on_cuda else "cpu"
        self._torch_dtype = self._pick_dtype(cfg.dtype, on_cuda)
        return on_cuda

    def load(self, cfg: LoadConfig) -> None:  # pragma: no cover — abstract
        raise NotImplementedError

    def transcribe(self, audio: np.ndarray, opts: dict[str, Any]) -> str:
        raise NotImplementedError

    def unload(self) -> None:
        self._model = None
        self._processor = None
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        gc.collect()


class _WhisperHandler(_BaseHandler):
    family = fd.STT_WHISPER

    def load(self, cfg: LoadConfig) -> None:
        import torch
        from transformers import WhisperForConditionalGeneration, AutoProcessor
        self._resolve_device(cfg)
        self._processor = AutoProcessor.from_pretrained(cfg.model_id)
        self._model = WhisperForConditionalGeneration.from_pretrained(
            cfg.model_id, torch_dtype=self._torch_dtype,
        ).to(self._torch_device)
        self._model.eval()
        if cfg.torch_compile:
            try:
                self._model = torch.compile(self._model, mode="reduce-overhead")
            except Exception as exc:
                log.warning("whisper: torch.compile failed (%s)", exc)
        if cfg.warmup:
            try:
                dummy = np.zeros(16000, dtype=np.float32)
                self.transcribe(dummy, {"language": "en"})
            except Exception as exc:
                log.warning("whisper warmup failed: %s", exc)

    def transcribe(self, audio: np.ndarray, opts: dict[str, Any]) -> str:
        import torch
        inputs = self._processor(audio, sampling_rate=16000, return_tensors="pt")
        feats = inputs.input_features.to(self._torch_device, dtype=self._torch_dtype)
        gen: dict = {
            "task": str(opts.get("task") or "transcribe"),
            "max_new_tokens": 440,
            "num_beams": max(1, int(opts.get("num_beams") or 1)),
        }
        lang = str(opts.get("language") or "").lower()
        if lang and lang != "auto":
            gen["language"] = lang
        prompt = str(opts.get("initial_prompt") or "")
        if prompt:
            try:
                pids = self._processor.get_prompt_ids(
                    prompt, return_tensors="pt",
                ).to(self._torch_device)
                gen["prompt_ids"] = pids
            except Exception:
                pass
        with torch.no_grad():
            out = self._model.generate(feats, **gen)
        text = self._processor.batch_decode(out, skip_special_tokens=True)[0]
        return (text or "").strip()


class _Wav2Vec2Handler(_BaseHandler):
    """CTC family: Wav2Vec2, HuBERT, WavLM, UniSpeech."""
    family = fd.STT_WAV2VEC2

    def load(self, cfg: LoadConfig) -> None:
        import torch
        from transformers import AutoModelForCTC, AutoProcessor
        self._resolve_device(cfg)
        self._processor = AutoProcessor.from_pretrained(cfg.model_id)
        self._model = AutoModelForCTC.from_pretrained(
            cfg.model_id, torch_dtype=self._torch_dtype,
        ).to(self._torch_device)
        self._model.eval()
        if cfg.torch_compile:
            try:
                self._model = torch.compile(self._model, mode="reduce-overhead")
            except Exception as exc:
                log.warning("ctc: torch.compile failed (%s)", exc)
        if cfg.warmup:
            try:
                self.transcribe(np.zeros(16000, dtype=np.float32), {})
            except Exception as exc:
                log.warning("ctc warmup failed: %s", exc)

    def transcribe(self, audio: np.ndarray, opts: dict[str, Any]) -> str:
        import torch
        inputs = self._processor(
            audio, sampling_rate=16000, return_tensors="pt", padding=True,
        )
        input_values = inputs.input_values.to(self._torch_device,
                                               dtype=self._torch_dtype)
        with torch.no_grad():
            logits = self._model(input_values).logits
        ids = torch.argmax(logits, dim=-1)
        text = self._processor.batch_decode(ids)[0]
        return (text or "").strip()


class _MMSHandler(_Wav2Vec2Handler):
    """MMS = Wav2Vec2 with per-language adapter heads.

    Loading the right adapter requires `target_lang=<iso>` at
    from_pretrained() time AND calling `model.load_adapter(...)`.
    We rebuild the model when `language` changes — the engine's
    `_key()` doesn't include `language`, so we do it ourselves here."""
    family = fd.STT_MMS

    def __init__(self) -> None:
        super().__init__()
        self._loaded_lang = ""
        self._model_id = ""
        self._cfg: LoadConfig | None = None

    def load(self, cfg: LoadConfig) -> None:
        # Defer real load until we know the target language.
        self._cfg = cfg
        self._model_id = cfg.model_id
        self._resolve_device(cfg)
        # MMS adapter weights are tiny — initial load with default lang.
        self._ensure_lang("eng")

    def _ensure_lang(self, lang: str) -> None:
        from transformers import Wav2Vec2ForCTC, AutoProcessor
        if not lang or lang == "auto":
            lang = "eng"
        # MMS uses 3-letter ISO 639-3 codes. Convert common 2-letter codes.
        lang3 = _ISO2_TO_ISO3.get(lang, lang)
        if self._loaded_lang == lang3 and self._model is not None:
            return
        log.info("mms: switching adapter → %s", lang3)
        self._processor = AutoProcessor.from_pretrained(
            self._model_id, target_lang=lang3,
        )
        self._model = Wav2Vec2ForCTC.from_pretrained(
            self._model_id, target_lang=lang3, ignore_mismatched_sizes=True,
            torch_dtype=self._torch_dtype,
        ).to(self._torch_device)
        self._model.load_adapter(lang3)
        self._model.eval()
        self._loaded_lang = lang3

    def transcribe(self, audio: np.ndarray, opts: dict[str, Any]) -> str:
        self._ensure_lang(str(opts.get("language") or "en").lower())
        return super().transcribe(audio, opts)


class _SeamlessHandler(_BaseHandler):
    family = fd.STT_SEAMLESS

    def load(self, cfg: LoadConfig) -> None:
        from transformers import AutoProcessor, SeamlessM4Tv2ForSpeechToText
        self._resolve_device(cfg)
        self._processor = AutoProcessor.from_pretrained(cfg.model_id)
        # Note: SeamlessM4Tv2 covers both v1 and v2 — single class.
        self._model = SeamlessM4Tv2ForSpeechToText.from_pretrained(
            cfg.model_id, torch_dtype=self._torch_dtype,
        ).to(self._torch_device)
        self._model.eval()

    def transcribe(self, audio: np.ndarray, opts: dict[str, Any]) -> str:
        import torch
        inputs = self._processor(audios=audio, sampling_rate=16000,
                                  return_tensors="pt")
        inputs = {k: v.to(self._torch_device,
                          dtype=self._torch_dtype if v.dtype.is_floating_point else v.dtype)
                  for k, v in inputs.items()}
        task = str(opts.get("task") or "transcribe")
        lang = str(opts.get("language") or "en").lower()
        # Seamless uses ISO 639-3 codes
        lang3 = _ISO2_TO_ISO3.get(lang, lang)
        tgt = "eng" if task == "translate" else lang3
        gen: dict = {
            "tgt_lang": tgt,
            "num_beams": max(1, int(opts.get("num_beams") or 5)),
        }
        with torch.no_grad():
            out = self._model.generate(**inputs, **gen)
        text = self._processor.batch_decode(out, skip_special_tokens=True)[0]
        return (text or "").strip()


class _MoonshineHandler(_BaseHandler):
    family = fd.STT_MOONSHINE

    def load(self, cfg: LoadConfig) -> None:
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor
        self._resolve_device(cfg)
        self._processor = AutoProcessor.from_pretrained(cfg.model_id)
        self._model = AutoModelForSpeechSeq2Seq.from_pretrained(
            cfg.model_id, torch_dtype=self._torch_dtype,
        ).to(self._torch_device)
        self._model.eval()

    def transcribe(self, audio: np.ndarray, opts: dict[str, Any]) -> str:
        import torch
        inputs = self._processor(audio, sampling_rate=16000, return_tensors="pt")
        feats = {k: v.to(self._torch_device,
                         dtype=self._torch_dtype if v.dtype.is_floating_point else v.dtype)
                 for k, v in inputs.items()}
        with torch.no_grad():
            out = self._model.generate(
                **feats, num_beams=max(1, int(opts.get("num_beams") or 1)),
                max_new_tokens=440,
            )
        text = self._processor.batch_decode(out, skip_special_tokens=True)[0]
        return (text or "").strip()


class _S2THandler(_BaseHandler):
    family = fd.STT_S2T

    def load(self, cfg: LoadConfig) -> None:
        from transformers import (
            Speech2TextForConditionalGeneration, Speech2TextProcessor,
        )
        self._resolve_device(cfg)
        self._processor = Speech2TextProcessor.from_pretrained(cfg.model_id)
        self._model = Speech2TextForConditionalGeneration.from_pretrained(
            cfg.model_id, torch_dtype=self._torch_dtype,
        ).to(self._torch_device)
        self._model.eval()

    def transcribe(self, audio: np.ndarray, opts: dict[str, Any]) -> str:
        import torch
        inputs = self._processor(audio, sampling_rate=16000, return_tensors="pt")
        feats = inputs.input_features.to(self._torch_device,
                                          dtype=self._torch_dtype)
        with torch.no_grad():
            out = self._model.generate(
                feats, num_beams=max(1, int(opts.get("num_beams") or 1)),
            )
        text = self._processor.batch_decode(out, skip_special_tokens=True)[0]
        return (text or "").strip()


class _GenericPipelineHandler(_BaseHandler):
    """Universal fallback — `transformers.pipeline("automatic-speech-recognition")`.
    Handles any model HF registers as ASR, including ones we haven't
    written a specific handler for."""
    family = fd.STT_GENERIC

    def __init__(self) -> None:
        super().__init__()
        self._pipe: Any = None

    def load(self, cfg: LoadConfig) -> None:
        from transformers import pipeline
        on_cuda = self._resolve_device(cfg)
        self._pipe = pipeline(
            "automatic-speech-recognition",
            model=cfg.model_id,
            device=0 if on_cuda else -1,
            torch_dtype=self._torch_dtype,
        )

    def transcribe(self, audio: np.ndarray, opts: dict[str, Any]) -> str:
        # pipeline accepts a numpy float32 array directly.
        out = self._pipe(audio.astype(np.float32))
        if isinstance(out, dict):
            return str(out.get("text") or "").strip()
        return str(out).strip()

    def unload(self) -> None:
        self._pipe = None
        super().unload()


# Family → handler class.
_HANDLERS: dict[str, type[_BaseHandler]] = {
    fd.STT_WHISPER:   _WhisperHandler,
    fd.STT_WAV2VEC2:  _Wav2Vec2Handler,
    fd.STT_MMS:       _MMSHandler,
    fd.STT_SEAMLESS:  _SeamlessHandler,
    fd.STT_MOONSHINE: _MoonshineHandler,
    fd.STT_S2T:       _S2THandler,
    fd.STT_SPEECHT5:  _GenericPipelineHandler,
    fd.STT_PARAKEET:  _GenericPipelineHandler,
    fd.STT_QWEN_AUDIO:_GenericPipelineHandler,
    fd.STT_GENERIC:   _GenericPipelineHandler,
}


# ── Public backend class ─────────────────────────────────────────────


class GenericSTTBackend(STTBackend):
    """One backend to rule them all."""
    name = "generic"
    default_model = "openai/whisper-base"
    priority = 0   # universal fallback; specialists outrank if needed

    def __init__(self) -> None:
        self._handler: _BaseHandler | None = None
        self._family: str = ""
        self._model_id: str = ""

    # ── Identity / capabilities ──────────────────────────────────────

    def detected_family(self) -> str:
        return self._family or ""

    def supports(self, feature: str) -> bool:
        return feature in fd.stt_capabilities(self._family or fd.STT_GENERIC)

    def language_options(self) -> list[tuple[str, str]]:
        from voxtype.backends.shared import WHISPER_LANGUAGES
        if self._family == fd.STT_MMS:
            # MMS supports 1107 langs; show a curated subset (its
            # processor uses 3-letter ISO 639-3, but we accept 2-letter
            # input and map). For now reuse the Whisper table — covers
            # the user's likely choices.
            return WHISPER_LANGUAGES
        if self._family == fd.STT_SEAMLESS:
            return WHISPER_LANGUAGES
        if self._family in {fd.STT_WAV2VEC2, fd.STT_MOONSHINE,
                             fd.STT_SPEECHT5}:
            # Single-language families. UI hides the picker.
            return [("en", "English")]
        return WHISPER_LANGUAGES

    def runtime_options(self) -> list[OptionSpec]:
        return fd.stt_runtime_options(self._family) if self._family else []

    # ── Lifecycle ────────────────────────────────────────────────────

    def load_sync(self, cfg: LoadConfig) -> None:
        self._model_id = cfg.model_id
        family = fd.detect_stt_family(cfg.model_id) or fd.STT_GENERIC
        log.info("generic-stt: detected family=%s for model=%s",
                 family, cfg.model_id)
        self._family = family
        cls = _HANDLERS.get(family, _GenericPipelineHandler)
        self._handler = cls()
        try:
            self._handler.load(cfg)
        except Exception as exc:
            log.warning("generic-stt: %s loader failed (%s); falling back "
                        "to pipeline()", family, exc)
            self._handler = _GenericPipelineHandler()
            self._family = fd.STT_GENERIC
            self._handler.load(cfg)

    def unload_sync(self) -> None:
        if self._handler is not None:
            try:
                self._handler.unload()
            except Exception as exc:
                log.debug("generic-stt unload exc: %s", exc)
        self._handler = None
        self._family = ""

    def transcribe_sync(self, pcm: bytes, opts: dict[str, Any]) -> str:
        if self._handler is None:
            raise RuntimeError("generic-stt: not loaded")
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        return self._handler.transcribe(audio, opts or {})

    def runtime_info(self) -> dict:
        h = self._handler
        return {
            "family": self._family,
            "model_id": self._model_id,
            "device": getattr(h, "_torch_device", "cpu") if h else "cpu",
            "dtype": str(getattr(h, "_torch_dtype", "")) if h else "",
        }


# ── Helpers ──────────────────────────────────────────────────────────

# Bare-minimum ISO 639-1 → ISO 639-3 map for MMS / Seamless. Adding more
# entries is a one-line tweak.
_ISO2_TO_ISO3: dict[str, str] = {
    "en": "eng", "es": "spa", "fr": "fra", "de": "deu", "it": "ita",
    "pt": "por", "nl": "nld", "ru": "rus", "pl": "pol", "tr": "tur",
    "zh": "cmn", "ja": "jpn", "ko": "kor", "ar": "ara", "hi": "hin",
    "bn": "ben", "ur": "urd", "sw": "swh", "ta": "tam", "te": "tel",
    "ml": "mal", "mr": "mar", "gu": "guj", "kn": "kan", "pa": "pan",
    "vi": "vie", "th": "tha", "id": "ind", "ms": "msa", "fa": "fas",
    "he": "heb", "el": "ell", "cs": "ces", "hu": "hun", "ro": "ron",
    "fi": "fin", "sv": "swe", "no": "nor", "da": "dan", "uk": "ukr",
}
