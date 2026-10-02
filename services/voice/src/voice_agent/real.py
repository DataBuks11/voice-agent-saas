"""Keyless production providers: faster-whisper STT, API-backed RAG LLM, piper TTS."""
from __future__ import annotations

import asyncio
import logging
import os

import httpx
import numpy as np

from .providers import AudioChunk, LLMProvider, STTProvider, TTSProvider, Transcript

log = logging.getLogger("voice.providers")


class FasterWhisperSTT(STTProvider):
    name = "faster-whisper"

    def __init__(self, model_size: str | None = None, cpu_threads: int = 4):
        from faster_whisper import WhisperModel

        size = model_size or os.getenv("STT_MODEL", "base.en")
        self._model = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=cpu_threads)
        self._lock = asyncio.Lock()
        log.info("STT ready: faster-whisper %s (int8)", size)

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
        segments, info = self._model.transcribe(
            audio,
            language="en",
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
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
        return {"Authorization": f"Bearer {token}", "x-workspace-id": self._ws}

    async def complete(self, system: str, context: str, user: str) -> str:
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


class PiperTTS(TTSProvider):
    name = "piper"

    def __init__(self, voice_path: str | None = None):
        self._voice_path = voice_path or os.getenv("PIPER_VOICE", "/voices/en_US-lessac-medium.onnx")
        self._voice = None
        self._lock = asyncio.Lock()
        log.info("TTS voice: %s", self._voice_path)

    def _load(self):
        if self._voice is None:
            from piper import PiperVoice

            self._voice = PiperVoice.load(self._voice_path)
        return self._voice

    async def synthesize(self, text: str, voice: str = "default") -> AudioChunk:
        async with self._lock:
            return await asyncio.to_thread(self._sync, text)

    def _sync(self, text: str) -> AudioChunk:
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
        return AudioChunk(pcm16=b"".join(parts), sample_rate=int(sample_rate))
