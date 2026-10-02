"""Provider abstractions: STT (Whisper-compatible), LLM, TTS (Chatterbox-compatible)."""
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class Transcript:
    text: str
    confidence: float = 1.0
    language: str = "en"


class STTProvider(ABC):
    name: str = "base-stt"

    @abstractmethod
    async def transcribe(self, pcm16: bytes, sample_rate: int = 16000) -> Transcript:
        raise NotImplementedError


class LLMProvider(ABC):
    name: str = "base-llm"

    @abstractmethod
    async def complete(self, system: str, context: str, user: str, draft: bool = False) -> str:
        raise NotImplementedError


@dataclass
class AudioChunk:
    pcm16: bytes
    sample_rate: int = 22050


class TTSProvider(ABC):
    name: str = "base-tts"

    @abstractmethod
    async def synthesize(self, text: str, voice: str = "default") -> AudioChunk:
        raise NotImplementedError


class StubSTT(STTProvider):
    """Local stub used when no STT key is configured. Clearly labeled, never silent-fake."""
    name = "stub-stt"

    async def transcribe(self, pcm16: bytes, sample_rate: int = 16000) -> Transcript:
        return Transcript(text="", confidence=0.0, language="en")


class StubLLM(LLMProvider):
    name = "stub-llm"

    async def complete(self, system: str, context: str, user: str, draft: bool = False) -> str:
        return "Voice pipeline stub: configure LLM_PROVIDER + LLM_API_KEY for real answers."


class StubTTS(TTSProvider):
    name = "stub-tts"

    async def synthesize(self, text: str, voice: str = "default") -> AudioChunk:
        return AudioChunk(pcm16=b"", sample_rate=22050)
