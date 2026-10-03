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

    async def transcribe(self, pcm16: bytes) -> str:
        """Transcript of arbitrary audio (used for speculative streaming drafts)."""
        result = await self.stt.transcribe(pcm16, self.config.sample_rate)
        return result.text

    async def transcribe_detailed(self, pcm16: bytes) -> tuple[str, float]:
        """Text plus decode confidence, so noise can be rejected before the LLM."""
        result = await self.stt.transcribe(pcm16, self.config.sample_rate)
        return result.text, float(getattr(result, "confidence", 1.0) or 0.0)

    async def handle_audio(self, pcm16: bytes, on_transcript=None, hypothesis: str = "") -> str:
        import time as _time

        t0 = _time.time()
        if hypothesis and self._hypothesis_usable(hypothesis, len(pcm16)):
            # The streaming draft already produced this transcript — no need to
            # transcribe the whole utterance again.
            text, t_stt = hypothesis, _time.time()
            log.info("stage stt reused-draft (%.2fs)", t_stt - t0)
        else:
            tr = await self.stt.transcribe(pcm16, self.config.sample_rate)
            t_stt = _time.time()
            text = tr.text
            if not text:
                log.info("stage stt %.2fs (empty)", t_stt - t0)
                return ""
        return await self._complete_turn(text, on_transcript, t0=t0, t_stt=t_stt)

    @staticmethod
    def _hypothesis_usable(hypothesis: str, audio_bytes: int) -> bool:
        """Trust the draft only when it plausibly covers the whole utterance."""
        seconds = audio_bytes / 2 / 16000
        words = hypothesis.split()
        if len(words) < 2:
            return False
        # Expected speech rate is ~2.5 words/second; allow a generous margin.
        return len(words) >= seconds * 1.1

    async def handle_text(self, text: str, on_transcript=None, draft: bool = False) -> str:
        """Browser-side STT (Web Speech API) arrives as text — skip server STT entirely."""
        import time as _time

        t0 = _time.time()
        if not text.strip():
            return ""
        if draft:
            # Speculative: warm the answer, stay silent, let the real turn speak.
            await self.llm.complete(
                system="You are a helpful voice assistant.",
                context=self.state.history_text(),
                user=text,
                draft=True,
            )
            return ""
        return await self._complete_turn(text, on_transcript, t0=t0, t_stt=None)

    async def _complete_turn(self, text: str, on_transcript, t0=None, t_stt=None) -> str:
        import time as _time

        self.state.add("user", text)
        if on_transcript is not None:
            result = on_transcript(text)
            if result is not None and hasattr(result, "__await__"):
                await result
        answer = await self.llm.complete(system="You are a helpful voice assistant.", context=self.state.history_text(), user=text)  # noqa: E501
        if t_stt is not None:
            log.info("stage stt %.2fs llm %.2fs", t_stt - t0, _time.time() - t_stt)
        elif t0 is not None:
            log.info("stage text llm %.2fs", _time.time() - t0)
        self.state.add("assistant", answer)
        self.interrupted = False
        return answer

    async def synthesize(self, text: str):
        return await self.tts.synthesize(text)
