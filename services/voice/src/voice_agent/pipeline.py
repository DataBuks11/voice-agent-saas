"""Minimal Pipecat voice pipeline: transport → STT → conversation state → TTS, with barge-in flag."""
from __future__ import annotations
import logging
from dataclasses import dataclass, field
from .providers import STTProvider, LLMProvider, TTSProvider

log = logging.getLogger("voice.pipeline")


@dataclass
class VoiceConfig:
    allow_barge_in: bool = True
    max_turns: int = 50
    sample_rate: int = 16000


@dataclass
class ConversationState:
    turns: list[dict] = field(default_factory=list)

    def add(self, role: str, content: str) -> None:
        self.turns.append({"role": role, "content": content})

    def history_text(self, last: int = 20) -> str:
        return "\n".join(f"{t['role']}: {t['content']}" for t in self.turns[-last:])


class VoicePipeline:
    """Transport-agnostic core; Pipecat Daily/WebRTC transport plugs in around it."""

    def __init__(self, stt: STTProvider, llm: LLMProvider, tts: TTSProvider, config: VoiceConfig | None = None):
        self.stt = stt
        self.llm = llm
        self.tts = tts
        self.config = config or VoiceConfig()
        self.state = ConversationState()
        self.interrupted = False

    def handle_barge_in(self) -> None:
        if self.config.allow_barge_in:
            self.interrupted = True
            log.info("barge-in: stopping TTS playback")

    async def handle_audio(self, pcm16: bytes, on_transcript=None) -> str:
        tr = await self.stt.transcribe(pcm16, self.config.sample_rate)
        if not tr.text:
            return ""
        self.state.add("user", tr.text)
        if on_transcript is not None:
            result = on_transcript(tr.text)
            if result is not None and hasattr(result, "__await__"):
                await result
        answer = await self.llm.complete(system="You are a helpful voice assistant.", context=self.state.history_text(), user=tr.text)
        self.state.add("assistant", answer)
        self.interrupted = False
        return answer

    async def synthesize(self, text: str):
        return await self.tts.synthesize(text)
