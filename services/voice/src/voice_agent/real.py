"""Providers: local (faster-whisper STT, piper TTS — keyless) or hosted HTTP
(OpenAI-compatible /audio/transcriptions + /audio/speech — faster, more human)."""
from __future__ import annotations

import asyncio
import io
import logging
import os
import wave

import httpx
import numpy as np

from .providers import AudioChunk, LLMProvider, STTProvider, TTSProvider, Transcript

log = logging.getLogger("voice.providers")

_HTTP_OK = ("", "api", "http", "openai", "whisper-compatible", "chatterbox-compatible")
_LOCAL = ("local", "faster-whisper", "piper")

# Workspace vocabulary used to bias speech recognition (agent names, known
# customers). Refreshed per session from the API; empty is harmless.
_STT_DICTIONARY: list[str] = []

# Beam width trades speed for accuracy: 1 is fastest (~3x faster than 3),
# ideal for instant sub-430ms conversational voice response.
BEAM_SIZE = max(1, min(5, int(os.getenv("STT_BEAM_SIZE", "1"))))

# The kinds of things callers say on the phone. Whisper leans hard on its prompt,
# so this pulls the decoder towards call language instead of dictation language.
CALL_VOCABULARY = (
    "Phone call with a customer. Front desk booking: appointment, booking, cleaning, consultation, "
    "checkup, new patient, returning patient, date of birth, morning, afternoon, evening, zip code, "
    "insurance, member ID, member id, policy number, hospital, patient, ambulance, body shifting, "
    "price, cost, timing, hours, address, map, transfer, call back, spell it out."
)


def build_stt_prompt() -> str | None:
    terms = [t for t in stt_dictionary()[:80] if t]
    if not terms:
        return CALL_VOCABULARY
    return f"{CALL_VOCABULARY} Names and terms: " + ", ".join(terms)


def set_stt_dictionary(terms: list[str]) -> None:
    global _STT_DICTIONARY
    cleaned = [t.strip() for t in terms if t and t.strip()]
    _STT_DICTIONARY = cleaned[:120]
    if cleaned:
        log.info("stt dictionary loaded: %d terms", len(_STT_DICTIONARY))


def stt_dictionary() -> list[str]:
    return list(_STT_DICTIONARY)


def stt_uses_http() -> bool:
    """Hosted STT when a key is present unless STT_PROVIDER forces local."""
    provider = (os.getenv("STT_PROVIDER") or "").strip().lower()
    if provider in _LOCAL:
        return False
    return bool(os.getenv("STT_API_KEY")) and (provider == "" or provider in _HTTP_OK)


def tts_uses_http() -> bool:
    """Hosted TTS when a key is present unless TTS_PROVIDER forces local."""
    provider = (os.getenv("TTS_PROVIDER") or "").strip().lower()
    if provider in _LOCAL:
        return False
    return bool(os.getenv("TTS_API_KEY")) and (provider == "" or provider in _HTTP_OK)


def stt_uses_deepgram() -> bool:
    """Deepgram when asked for explicitly, or when only its key is configured."""
    provider = (os.getenv("STT_PROVIDER") or "").strip().lower()
    if provider in _LOCAL:
        return False
    if provider == "deepgram":
        return True
    return provider == "" and bool(os.getenv("DEEPGRAM_API_KEY"))


def tts_uses_deepgram() -> bool:
    """Deepgram Aura when asked for explicitly, or when only its key is configured."""
    provider = (os.getenv("TTS_PROVIDER") or "").strip().lower()
    if provider in _LOCAL:
        return False
    if provider == "deepgram":
        return True
    return provider in ("", "auto") and bool(os.getenv("DEEPGRAM_API_KEY"))


def wav_bytes(pcm16: bytes, sample_rate: int) -> bytes:
    """PCM16 mono -> WAV container (OpenAI-compatible /audio/transcriptions input)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm16)
    return buf.getvalue()


def _retry_delay(attempt: int) -> float:
    return 0.4 * (2 ** attempt)


class HttpSTT(STTProvider):
    """OpenAI-compatible /audio/transcriptions (hosted whisper). ~0.5-1s vs local CPU."""

    name = "http-stt"

    def __init__(self) -> None:
        self._key = os.environ["STT_API_KEY"]
        self._base = (os.getenv("STT_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
        self._model = os.getenv("STT_MODEL", "whisper-1")
        self._language = os.getenv("STT_LANGUAGE", "en")
        self._client = httpx.AsyncClient(timeout=45.0)
        log.info("STT ready: http %s @ %s", self._model, self._base)

    async def transcribe(self, pcm16: bytes, sample_rate: int = 16000) -> Transcript:
        if sample_rate != 16000:
            audio = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32)
            target = int(len(audio) * 16000 / sample_rate)
            if target < 160:
                return Transcript(text="", confidence=0.0)
            audio = np.interp(np.linspace(0, len(audio) - 1, target), np.arange(len(audio)), audio)
            pcm16 = audio.astype(np.int16).tobytes()
            sample_rate = 16000
        if len(pcm16) < 320:
            return Transcript(text="", confidence=0.0)
        wav = wav_bytes(pcm16, sample_rate)
        data = {"model": self._model, "language": self._language}
        files = {"file": ("audio.wav", wav, "audio/wav")}
        last_status = 0
        for attempt in range(3):
            if attempt:
                await asyncio.sleep(_retry_delay(attempt - 1))
            try:
                r = await self._client.post(
                    f"{self._base}/audio/transcriptions",
                    headers={"authorization": f"Bearer {self._key}"},
                    data=data,
                    files=files,
                )
            except httpx.HTTPError as exc:
                log.error("STT http error: %s", exc)
                return Transcript(text="", confidence=0.0)
            last_status = r.status_code
            if r.status_code == 429 or r.status_code >= 500:
                continue
            break
        if last_status >= 400:
            log.error("STT http failed: %s", last_status)
            return Transcript(text="", confidence=0.0)
        text = str((r.json() or {}).get("text") or "").strip()
        return Transcript(text=text, confidence=0.9, language=self._language)


class HttpTTS(TTSProvider):
    """OpenAI-compatible /audio/speech with response_format=pcm (24 kHz PCM16 mono)."""

    name = "http-tts"

    def __init__(self) -> None:
        self._key = os.environ["TTS_API_KEY"]
        self._base = (os.getenv("TTS_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
        self._model = os.getenv("TTS_MODEL", "gpt-4o-mini-tts")
        voice_env = (os.getenv("TTS_VOICE") or "").strip()
        # "default" is our internal placeholder, not a provider voice name.
        self._voice = "alloy" if voice_env in ("", "default") else voice_env
        self._sample_rate = int(os.getenv("TTS_SAMPLE_RATE", "24000"))
        self._client = httpx.AsyncClient(timeout=60.0)
        log.info("TTS ready: http %s voice=%s @ %s", self._model, self._voice, self._base)

    async def synthesize(self, text: str, voice: str = "default") -> AudioChunk:
        payload = {
            "model": self._model,
            "voice": self._voice if voice in ("", "default") else voice,
            "input": text,
            "response_format": "pcm",
        }
        last_status = 0
        for attempt in range(3):
            if attempt:
                await asyncio.sleep(_retry_delay(attempt - 1))
            try:
                r = await self._client.post(
                    f"{self._base}/audio/speech",
                    json=payload,
                    headers={"authorization": f"Bearer {self._key}"},
                )
            except httpx.HTTPError as exc:
                log.error("TTS http error: %s", exc)
                return AudioChunk(pcm16=b"", sample_rate=self._sample_rate)
            last_status = r.status_code
            if r.status_code == 429 or r.status_code >= 500:
                continue
            break
        if last_status >= 400:
            log.error("TTS http failed: %s %s", last_status, r.text[:200])
            return AudioChunk(pcm16=b"", sample_rate=self._sample_rate)
        return AudioChunk(pcm16=r.content, sample_rate=self._sample_rate)


class DeepgramSTT(STTProvider):
    """Deepgram pre-recorded /v1/listen (nova-3).

    Cloud STT is roughly 0.2-0.4 s per turn and, unlike local whisper on a small
    CPU, does not turn speaker bleed into confident nonsense -- which is what
    caused phantom barge-ins and invented answers.
    """

    name = "deepgram"

    def __init__(self) -> None:
        self._key = os.environ["DEEPGRAM_API_KEY"]
        model = (os.getenv("DEEPGRAM_STT_MODEL") or os.getenv("DEEPGRAM_MODEL") or "").strip()
        if not model:
            stt_model = (os.getenv("STT_MODEL") or "").strip()
            model = stt_model if stt_model and not stt_model.endswith(".en") else "nova-3"
        self._model = model
        self._language = (os.getenv("STT_LANGUAGE") or "en").strip()
        self._base = (os.getenv("DEEPGRAM_BASE_URL") or "https://api.deepgram.com/v1").rstrip("/")
        self._timeout = float(os.getenv("DEEPGRAM_TIMEOUT_S", "20"))
        self._client = httpx.AsyncClient(timeout=self._timeout)
        # The caller we settled on: background voices and side conversations must
        # never become the transcript we answer.
        self._speaker: str | None = None
        # Set by the server before the committed pass; interim drafts skip it.
        self.final_pass = True
        log.info("STT ready: deepgram %s lang=%s diarize=%s", self._model, self._language,
                 self._diarize)

    @property
    def _diarize(self) -> bool:
        # Default to False for ultra-low latency voice agent (eliminates ~600ms diarization lag)
        return (os.getenv("STT_DIARIZE") or "0").strip().lower() in ("1", "true", "yes")

    def _params(self) -> dict[str, str]:
        params = {
            "model": self._model,
            "smart_format": "true",
            "punctuate": "true",
            # Verbatim: prices, times and phone numbers must come back as digits
            # ("$90", "10:30"), not spelled out, or the caller is misquoted.
            "numerals": "true",
            "filler_words": "false",
        }
        lang = (self._language or "en").strip().lower()
        if not lang or lang == "auto":
            lang = "en"
        params["language"] = lang
        if self._diarize and self.final_pass:
            # Speaker attribution is only enabled when explicitly configured
            params["diarize"] = "true"
            params["utterances"] = "true"
        # Deepgram biases towards these terms, the hosted equivalent of the
        # local whisper prompt (agent names, known customers).
        terms = [t for t in stt_dictionary()[:80] if t]
        for term in terms:
            params["keyterm"] = term
        return params

    def _caller_text(self, utterances: list[dict]) -> str:
        """Join one speaker's speech only.

        On the first turn the caller is whoever talks most; afterwards we keep
        answering that same voice, so a loud TV or a passer-by cannot take the
        call over mid-conversation.
        """
        spoken: dict[str, float] = {}
        for u in utterances:
            if u.get("transcript"):
                spoken[str(u.get("speaker"))] = spoken.get(str(u.get("speaker")), 0.0) + float(
                    u.get("end", 0) - u.get("start", 0))
        if not spoken:
            return ""
        if self._speaker not in spoken:
            self._speaker = max(spoken, key=lambda k: spoken[k])
            log.info("caller voice: speaker %s (%.1fs)", self._speaker, spoken[self._speaker])
        keep = " ".join(str(u.get("transcript") or "").strip()
                        for u in utterances if str(u.get("speaker")) == self._speaker)
        dropped = sorted((k for k in spoken if k != self._speaker), key=lambda k: -spoken[k])
        if dropped:
            log.info("ignored %d other voice(s) totalling %.1fs",
                     len(dropped), sum(spoken[k] for k in dropped))
        return keep.strip()

    async def transcribe(self, pcm16: bytes, sample_rate: int = 16000) -> Transcript:
        if len(pcm16) < 320:
            return Transcript(text="", confidence=0.0)
        if sample_rate != 16000:
            audio = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32)
            target = int(len(audio) * 16000 / sample_rate)
            if target < 160:
                return Transcript(text="", confidence=0.0)
            audio = np.interp(np.linspace(0, len(audio) - 1, target), np.arange(len(audio)), audio)
            pcm16 = audio.astype(np.int16).tobytes()
        wav = wav_bytes(pcm16, 16000)
        last_status = 0
        payload: dict = {}
        for attempt in range(3):
            if attempt:
                await asyncio.sleep(_retry_delay(attempt - 1))
            try:
                r = await self._client.post(
                    f"{self._base}/listen",
                    params=self._params(),
                    content=wav,
                    headers={
                        "authorization": f"Token {self._key}",
                        "content-type": "audio/wav",
                    },
                )
            except httpx.HTTPError as exc:
                log.error("deepgram error: %s", exc)
                return Transcript(text="", confidence=0.0)
            last_status = r.status_code
            if r.status_code == 429 or r.status_code >= 500:
                continue
            break
        if last_status >= 400:
            log.error("deepgram failed: %s %s", last_status, r.text[:200])
            return Transcript(text="", confidence=0.0)
        payload = r.json() or {}
        results = payload.get("results") or {}
        channels = results.get("channels") or []
        alternatives = (channels[0].get("alternatives") or [{}])[0] if channels else {}
        utterances = results.get("utterances") or []
        if self._diarize and self.final_pass and utterances:
            text = self._caller_text(utterances)
        else:
            text = str(alternatives.get("transcript") or "").strip()
        confidence = float(alternatives.get("confidence") or 0.0)
        detected = str(channels[0].get("detected_language") or self._language) if channels else self._language
        return Transcript(text=text, confidence=confidence, language=detected)


def build_stt() -> STTProvider:
    if stt_uses_deepgram():
        return DeepgramSTT()
    if stt_uses_http():
        return HttpSTT()
    return FasterWhisperSTT()


def _mp3_to_pcm16(mp3: bytes) -> tuple[bytes, int]:
    """edge-tts streams MP3 @ 24 kHz → decode to PCM16 mono."""
    import io

    import av
    import numpy as np

    container = av.open(io.BytesIO(mp3))
    sr = int(container.streams.audio[0].sample_rate or 24000)
    frames = list(container.decode(audio=0))
    if not frames:
        return b"", 24000
    data = np.concatenate([f.to_ndarray().reshape(-1) for f in frames])
    if data.dtype != np.int16:
        data = (np.clip(data, -1.0, 1.0) * 32767.0).astype(np.int16)
    if sr != 24000:
        n = int(len(data) * 24000 / sr)
        data = np.interp(np.linspace(0, len(data) - 1, n), np.arange(len(data)), data).astype(np.int16)
    return data.tobytes(), 24000


class EdgeTTS(TTSProvider):
    """Microsoft Edge neural voices (en-US-AvaNeural etc) — natural American tone, no API key."""

    name = "edge-tts"

    # One voice per language so a Hindi caller hears a Hindi receptionist.
    VOICE_BY_LANG = {
        "hi": "hi-IN-SwaraNeural",
        "mr": "mr-IN-AarohiNeural",
        "bn": "bn-IN-TomtomNeural",
        "ta": "ta-IN-PallaviNeural",
        "te": "te-IN-VaniNeural",
        "kn": "kn-IN-SarikaNeural",
        "gu": "gu-IN-DhwaniNeural",
        "pa": "pa-IN-AnanyaNeural",
        "es": "es-ES-ElviraNeural",
        "ar": "ar-EG-SalmaNeural",
        "en": "en-US-AvaNeural",
    }

    def __init__(self) -> None:
        self._configured = (os.getenv("EDGE_TTS_VOICE") or "").strip()
        self._rate = (os.getenv("EDGE_TTS_RATE") or "-5%").strip()
        self._timeout = float(os.getenv("EDGE_TTS_TIMEOUT_S", "30"))
        self.language = "en"

    def set_language(self, language: str) -> None:
        lang = (language or "en").strip().lower()[:2]
        if lang != (self.language or "en")[:2]:
            self.language = lang
            log.info("tts language -> %s", self._voice_name())

    def _voice_name(self) -> str:
        if self._configured:
            return self._configured
        lang = (self.language or "en").strip().lower()[:2]
        return self.VOICE_BY_LANG.get(lang, self.VOICE_BY_LANG["en"])

    async def synthesize(self, text: str, voice: str = "default") -> AudioChunk:
        import edge_tts

        target = self._voice_name() if voice in ("", "default") else voice
        buf = bytearray()

        async def _run() -> None:
            comm = edge_tts.Communicate(text, target, rate=self._rate)
            async for chunk in comm.stream():
                if chunk.get("type") == "audio":
                    buf.extend(chunk.get("data") or b"")

        await asyncio.wait_for(_run(), timeout=self._timeout)
        if not buf:
            log.error("edge-tts returned no audio for voice=%s", target)
            return AudioChunk(pcm16=b"", sample_rate=24000)
        pcm, sr = await asyncio.to_thread(_mp3_to_pcm16, bytes(buf))
        return AudioChunk(pcm16=pcm, sample_rate=sr)


class FallbackTTS(TTSProvider):
    """Prefer the natural neural voice; first failure flips to the local backup for the session."""

    def __init__(self, primary: TTSProvider, backup: TTSProvider) -> None:
        self.primary = primary
        self.backup = backup
        self.failed = False
        self.name = primary.name

    async def synthesize(self, text: str, voice: str = "default") -> AudioChunk:
        if not self.failed:
            try:
                chunk = await self.primary.synthesize(text, voice)
                if chunk.pcm16:
                    return chunk
                raise RuntimeError(f"{self.primary.name} returned empty audio")
            except Exception as exc:  # noqa: BLE001 - provider swap must be seamless
                log.warning("tts primary failed (%s) — switching to %s for this session", exc, self.backup.name)
                self.failed = True
                self.name = self.backup.name
        return await self.backup.synthesize(text, voice)


class DeepgramTTS(TTSProvider):
    """Deepgram Aura text-to-speech (24 kHz PCM16 mono).

    Fast, human neural speech via Deepgram's /v1/speak endpoint.
    If the project lacks speak permissions or an outage occurs, seamlessly
    switches to local Piper ONNX (<90ms) instead of stalling the conversation.
    """

    name = "deepgram-tts"

    def __init__(self) -> None:
        self._key = os.environ["DEEPGRAM_API_KEY"]
        self._voice = os.getenv("DEEPGRAM_TTS_VOICE", "aura-asteria-en")
        self._sample_rate = int(os.getenv("DEEPGRAM_TTS_SAMPLE_RATE", "24000"))
        self._base = (os.getenv("DEEPGRAM_BASE_URL") or "https://api.deepgram.com/v1").rstrip("/")
        self._client = httpx.AsyncClient(timeout=20.0)
        self._fallback = build_tts_fallback()
        self._fallback_only = False
        log.info("TTS ready: deepgram voice=%s (fallback=%s)", self._voice, self._fallback.name)

    async def synthesize(self, text: str, voice: str = "default") -> AudioChunk:
        if self._fallback_only:
            return await self._fallback.synthesize(text, voice)
        target = self._voice if voice in ("", "default") else voice
        try:
            r = await self._client.post(
                f"{self._base}/speak",
                params={"model": target, "encoding": "linear16",
                        "sample_rate": str(self._sample_rate), "container": "none"},
                content=(text or "").encode("utf-8"),
                headers={"authorization": f"Token {self._key}", "content-type": "text/plain"},
            )
        except httpx.HTTPError as exc:
            log.warning("deepgram tts error (%s) - using %s", exc, self._fallback.name)
            return await self._fallback.synthesize(text, voice)
        if r.status_code != 200 or len(r.content) < 64:
            log.warning(
                "deepgram tts returned %s (%s) - switching to %s",
                r.status_code, r.text[:100], self._fallback.name,
            )
            if r.status_code in (401, 403, 404):
                self._fallback_only = True
            return await self._fallback.synthesize(text, voice)
        return AudioChunk(pcm16=r.content, sample_rate=self._sample_rate)


def build_tts_fallback() -> TTSProvider:
    # Always prefer local Piper ONNX for instant ~80ms TTS in production container
    try:
        return PiperTTS()
    except Exception as exc:
        log.warning("PiperTTS init failed (%s) - trying edge-tts", exc)
        try:
            return EdgeTTS()
        except Exception:
            return PiperTTS()


def build_tts() -> TTSProvider:
    if tts_uses_deepgram():
        return DeepgramTTS()
    if tts_uses_http():
        return HttpTTS()
    provider = (os.getenv("TTS_PROVIDER") or "").strip().lower()
    if provider == "deepgram":
        return DeepgramTTS()
    if provider in _LOCAL or provider == "piper":
        return PiperTTS()
    if provider in ("edge", "edge-tts"):
        return EdgeTTS()
    return build_tts_fallback()


class FasterWhisperSTT(STTProvider):
    name = "faster-whisper"

    def __init__(self, model_size: str | None = None, cpu_threads: int = 4):
        from faster_whisper import WhisperModel

        size = model_size or os.getenv("STT_MODEL", "base.en")
        self._model_name = size
        self._model_is_english_only = size.endswith(".en")
        self._cpu_threads = cpu_threads
        self._model = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=cpu_threads)
        self._lock = asyncio.Lock()
        configured = (os.getenv("STT_LANGUAGE") or "auto").strip().lower() or "auto"
        # "auto" lets whisper detect the language: forcing "en" mangles Hindi/Hinglish.
        self._language = None if configured in ("auto", "") else configured
        self._configured_language = configured if configured != "auto" else ""
        log.info("STT ready: faster-whisper %s (int8) lang=%s", size, self._language or "auto")

    def describe(self) -> dict:
        """What the client and the dev UI need to know about STT."""
        return {
            "engine": self.name,
            "model": self._model_name,
            "language": self._language or "auto",
            "englishOnly": self._model_is_english_only,
            "beamSize": BEAM_SIZE,
            "inputSampleRate": 16000,
        }

    def set_language(self, language: str) -> None:
        """Pin the decoder to the agent's language.

        An English-only model cannot decode Hindi/Marathi/... so the multilingual
        model is loaded lazily the first time such an agent connects, instead of
        silently mistaking the language for English.
        """
        if self._configured_language:
            return
        lang = (language or "en").strip().lower()[:2]
        if not lang:
            return
        if self._model_is_english_only and lang != "en":
            # base.en literally cannot decode Hindi: swap models instead of guessing.
            self._load_multilingual(lang)
            return
        # "auto" stays in force when the operator did not pin a language.
        self._language = lang if self._configured_language else (None if lang == "en" else lang)
        log.info("stt language -> %s (model %s)", self._language or "auto", self._model_name)

    def _load_multilingual(self, lang: str) -> None:
        """Swap to the multilingual model (once) so the agent language is real."""
        target = os.getenv("STT_MODEL_MULTILINGUAL", "small")
        if target.endswith(".en"):
            target = target[:-3]
        if self._model_name == target:
            self._language = lang
            log.info("stt language -> %s (multilingual %s)", lang, target)
            return
        try:
            from faster_whisper import WhisperModel

            log.info("loading multilingual STT %s for language %s", target, lang)
            self._model = WhisperModel(
                target, device="cpu", compute_type="int8", cpu_threads=self._cpu_threads
            )
            self._model_name = target
            self._model_is_english_only = False
            self._language = lang
        except Exception:  # noqa: BLE001 - never fail a call over this
            log.exception("multilingual STT unavailable; staying on %s", self._model_name)
            self._language = None

    async def transcribe(self, pcm16: bytes, sample_rate: int = 16000) -> Transcript:
        async with self._lock:
            return await asyncio.to_thread(self._sync, pcm16, sample_rate)

    def _sync(self, pcm16: bytes, sample_rate: int) -> Transcript:
        audio = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
        if len(audio) < 160:
            return Transcript(text="", confidence=0.0)
        if sample_rate != 16000:
            target = int(len(audio) * 16000 / sample_rate)
            if target < 160:
                return Transcript(text="", confidence=0.0)
            audio = np.interp(np.linspace(0, len(audio) - 1, target), np.arange(len(audio)), audio).astype(np.float32)
        # Known names/business terms plus call vocabulary bias the decoder, so the
        # transcript comes back with the wording this business actually uses.
        prompt = build_stt_prompt()
        segments, info = self._model.transcribe(
            audio,
            language=self._language,
            task="transcribe",
            beam_size=BEAM_SIZE,
            best_of=BEAM_SIZE,
            temperature=0.0,
            vad_filter=os.getenv("STT_VAD_FILTER", "false").lower() in ("1", "true", "yes"),
            condition_on_previous_text=False,
            initial_prompt=prompt,
        )
        parts, logprobs = [], []
        for seg in segments:
            parts.append(seg.text.strip())
            if seg.avg_logprob is not None:
                logprobs.append(seg.avg_logprob)
        text = " ".join(parts).strip()
        confidence = float(np.exp(np.mean(logprobs))) if logprobs else 0.5
        return Transcript(text=text, confidence=max(0.0, min(confidence, 1.0)), language=getattr(info, "language", "en"))


class VoiceAuth:
    """Email+password JWT holder for the voice runtime acting on behalf of a tenant."""

    def __init__(self, api_base: str, email: str, password: str):
        self._api = api_base
        self._email = email
        self._password = password
        self._token: str | None = None
        self._lock = asyncio.Lock()

    async def token(self) -> str:
        if self._token:
            return self._token
        async with self._lock:
            if self._token:
                return self._token
            await self._login_locked()
            return self._token or ""

    async def refresh(self) -> str:
        async with self._lock:
            await self._login_locked()
            return self._token or ""

    async def _login_locked(self) -> None:
        async with httpx.AsyncClient(base_url=self._api, timeout=30.0) as client:
            r = await client.post("/v1/auth/login", json={"email": self._email, "password": self._password})
            r.raise_for_status()
            self._token = r.json()["token"]
        log.info("voice auth: logged in as %s", self._email)

    def invalidate(self) -> None:
        self._token = None


class ApiLLM(LLMProvider):
    """Turn-taking through the platform API: RAG retrieval + grounding + LLM answer."""

    name = "api-rag-llm"

    def __init__(
        self,
        api_base: str,
        workspace_id: str,
        conversation_id: str,
        agent_id: str | None = None,
        auth: VoiceAuth | None = None,
        token: str | None = None,
    ):
        self._api = api_base
        self._ws = workspace_id
        self._cid = conversation_id
        self._agent_id = agent_id
        self._auth = auth
        self._token = token
        self._client = httpx.AsyncClient(base_url=api_base, timeout=90.0)

    async def _headers(self) -> dict:
        token = await self._auth.token() if self._auth else (self._token or "")
        return {"Authorization": f"Bearer {token}", "x-workspace-id": self._ws, "x-voice-channel": "voice"}

    async def complete(self, system: str, context: str, user: str, draft: bool = False) -> str:
        payload: dict = {"workspaceId": self._ws, "content": user}
        if self._agent_id:
            payload["agentId"] = self._agent_id
        r = await self._client.post(f"/v1/conversations/{self._cid}/messages", json=payload, headers=await self._headers())
        if r.status_code == 401 and self._auth:
            self._auth.invalidate()
            r = await self._client.post(f"/v1/conversations/{self._cid}/messages", json=payload, headers=await self._headers())
        if r.status_code >= 500 or r.status_code == 401:
            log.error("LLM turn failed: %s %s", r.status_code, r.text[:300])
            return "Sorry, I hit a temporary problem answering that. Please try again."
        data = r.json()
        answer = data.get("answer")
        text = answer.get("content") if isinstance(answer, dict) else answer
        return str(text or data.get("reply") or "")

    async def stream(self, system: str, context: str, user: str):
        """Yield answer text as the API produces it.

        The caller synthesises each sentence the moment it is complete, so the
        first audio leaves while the model is still writing the rest.
        """
        import json as _json

        payload: dict = {"workspaceId": self._ws, "content": user, "stream": True}
        if self._agent_id:
            payload["agentId"] = self._agent_id
        headers = await self._headers()
        try:
            async with self._client.stream(
                "POST", f"/v1/conversations/{self._cid}/messages", json=payload, headers=headers
            ) as response:
                if response.status_code >= 400:
                    log.error("stream turn failed: %s", response.status_code)
                    yield await self.complete(system, context, user)
                    return
                async for line in response.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    try:
                        event = _json.loads(line[5:].strip())
                    except Exception:  # noqa: BLE001 - keep-alive noise
                        continue
                    kind = event.get("type")
                    if kind == "delta" and event.get("text"):
                        yield str(event["text"])
                    elif kind == "error":
                        log.error("stream error: %s", event.get("message"))
        except asyncio.CancelledError:  # pragma: no cover - barge-in
            raise
        except Exception as exc:  # noqa: BLE001 - fall back to one shot
            log.warning("stream unavailable (%s); using single-shot completion", exc)
            text = await self.complete(system, context, user)
            if text:
                yield text

    async def aclose(self) -> None:
        await self._client.aclose()


def _limit_onnx_threads() -> None:
    """Cap onnxruntime threads — containers see HOST core count but run under a
    small CPU quota, so default (all cores) oversubscribes badly and synthesis
    drops to ~0.3x realtime. Idempotent; TTS_ONNX_THREADS overrides."""
    if getattr(_limit_onnx_threads, "_done", False):
        return
    try:
        import onnxruntime as ort

        cap = int(os.getenv("TTS_ONNX_THREADS", "2"))

        class _LimitedOptions(ort.SessionOptions):  # type: ignore[misc]
            def __init__(self) -> None:
                super().__init__()
                self.intra_op_num_threads = cap
                self.inter_op_num_threads = 1

        ort.SessionOptions = _LimitedOptions  # type: ignore[misc, assignment]
        _limit_onnx_threads._done = True  # type: ignore[attr-defined]
        log.info("onnxruntime threads capped at %d", cap)
    except Exception:  # noqa: BLE001 - best effort
        log.warning("could not cap onnxruntime threads")


class PiperTTS(TTSProvider):
    name = "piper"

    def __init__(self, voice_path: str | None = None):
        self._voice_path = voice_path or os.getenv("PIPER_VOICE", "/voices/en_US-lessac-medium.onnx")
        self._voice = None
        self._lock = asyncio.Lock()
        log.info("TTS voice: %s", self._voice_path)

    def _load(self):
        if self._voice is None:
            import time as _time

            from piper import PiperVoice

            _limit_onnx_threads()
            t0 = _time.time()
            self._voice = PiperVoice.load(self._voice_path)
            log.info("piper load %.2fs", _time.time() - t0)
        return self._voice

    async def synthesize(self, text: str, voice: str = "default") -> AudioChunk:
        async with self._lock:
            return await asyncio.to_thread(self._sync, text)

    def _sync(self, text: str) -> AudioChunk:
        import time as _time

        t0 = _time.time()
        v = self._load()
        parts: list[bytes] = []
        sample_rate = 22050
        if hasattr(v, "synthesize_stream_raw"):
            for raw in v.synthesize_stream_raw(text):
                parts.append(raw)
            sample_rate = getattr(getattr(v, "config", None), "sample_rate", 22050)
        else:
            for chunk in v.synthesize(text):
                sample_rate = getattr(chunk, "sample_rate", sample_rate)
                data = getattr(chunk, "audio_int16_bytes", None) or getattr(chunk, "_audio_int16_bytes", b"")
                if data:
                    parts.append(bytes(data))
        pcm = b"".join(parts)
        audio_s = len(pcm) / 2 / max(sample_rate, 1)
        log.info("piper synth %.2fs (audio %.2fs, text=%r)", _time.time() - t0, audio_s, text[:40])
        return AudioChunk(pcm16=pcm, sample_rate=int(sample_rate))
