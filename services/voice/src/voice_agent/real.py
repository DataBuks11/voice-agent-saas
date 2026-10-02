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

# Beam width trades speed for accuracy: 1 is fastest, 5 is what a real
# receptionist call deserves (STT runs off the critical path).
BEAM_SIZE = max(1, min(5, int(os.getenv("STT_BEAM_SIZE", "3"))))

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


def build_stt() -> STTProvider:
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


def build_tts() -> TTSProvider:
    if tts_uses_http():
        return HttpTTS()
    provider = (os.getenv("TTS_PROVIDER") or "").strip().lower()
    if provider in _LOCAL:
        return PiperTTS()
    backup = PiperTTS()
    try:
        edge = EdgeTTS()
    except Exception:  # noqa: BLE001 - edge-tts missing → local voice
        log.warning("edge-tts unavailable — using piper")
        return backup
    return FallbackTTS(edge, backup)


class FasterWhisperSTT(STTProvider):
    name = "faster-whisper"

    def __init__(self, model_size: str | None = None, cpu_threads: int = 4):
        from faster_whisper import WhisperModel

        size = model_size or os.getenv("STT_MODEL", "base.en")
        self._model_is_english_only = size.endswith(".en")
        self._model = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=cpu_threads)
        self._lock = asyncio.Lock()
        configured = (os.getenv("STT_LANGUAGE") or "auto").strip().lower() or "auto"
        # "auto" lets whisper detect the language: forcing "en" mangles Hindi/Hinglish.
        self._language = None if configured in ("auto", "") else configured
        self._configured_language = configured if configured != "auto" else ""
        log.info("STT ready: faster-whisper %s (int8) lang=%s", size, self._language or "auto")

    def set_language(self, language: str) -> None:
        """Pin the decoder to the agent's language when the operator asked for one."""
        if self._configured_language:
            return
        lang = (language or "en").strip().lower()[:2]
        if not lang:
            return
        # A .en model only decodes English; other languages need the multilingual one.
        if self._model_is_english_only and lang != "en":
            log.info("stt stays auto (english-only model, got %s)", lang)
            return
        if lang != (self._language or "en")[:2]:
            self._language = None if lang == "en" and not self._configured_language else lang
            log.info("stt language -> %s", self._language or "auto")

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
            vad_filter=True,
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
