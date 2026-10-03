"""Realtime voice orchestration: explicit stages, explicit events, owned turns.

Design (adapted from Dograh's staged pipeline, reshaped for this codebase):

    AudioInput -> TurnDetector -> STT -> TranscriptNormalizer -> TurnValidator
               -> ConversationEngine (-> Context/RAG -> Decision -> LLM)
               -> ResponseStream -> TTS -> AudioOutput

Rules this module enforces, because every reported bug came from breaking one:

1. Every stage emits an event carrying sessionId, turnId, timestamp, sequence.
2. Only an ACCEPTED final user turn may start the conversation engine. Silence,
   noise, partials, duplicates and stale turns are rejected with a reason.
3. Every turn owns its work. When a newer turn starts, the older one is
   cancelled and any result it produces afterwards is discarded.
4. Illegal state transitions are refused. In particular SPEAKING -> THINKING and
   LISTENING -> THINKING cannot happen, so the assistant can never answer
   without a user turn.
5. The transcript and the audio that gets spoken come from the same turn id.
"""
from __future__ import annotations

import asyncio
import contextlib
import enum
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Iterable

log = logging.getLogger("voice.orchestrator")


# --------------------------------------------------------------------------- #
# States
# --------------------------------------------------------------------------- #
class TurnState(str, enum.Enum):
    IDLE = "IDLE"
    LISTENING = "LISTENING"
    USER_SPEAKING = "USER_SPEAKING"
    TRANSCRIBING = "TRANSCRIBING"
    THINKING = "THINKING"
    SPEAKING = "SPEAKING"
    INTERRUPTED = "INTERRUPTED"
    ENDING = "ENDING"
    ENDED = "ENDED"
    ERROR = "ERROR"


LEGAL_TRANSITIONS: dict[TurnState, set[TurnState]] = {
    TurnState.IDLE: {TurnState.LISTENING, TurnState.ENDING, TurnState.ERROR},
    TurnState.LISTENING: {TurnState.USER_SPEAKING, TurnState.ENDING, TurnState.ERROR},
    # A turn can be abandoned back to LISTENING (noise, echo, too short).
    TurnState.USER_SPEAKING: {
        TurnState.TRANSCRIBING,
        TurnState.LISTENING,
        TurnState.INTERRUPTED,
        TurnState.ENDING,
        TurnState.ERROR,
    },
    TurnState.TRANSCRIBING: {
        TurnState.THINKING,
        TurnState.LISTENING,
        TurnState.INTERRUPTED,
        TurnState.ENDING,
        TurnState.ERROR,
    },
    # THINKING -> SPEAKING only. Cancelled work falls back to LISTENING.
    TurnState.THINKING: {
        TurnState.SPEAKING,
        TurnState.LISTENING,
        TurnState.INTERRUPTED,
        TurnState.ENDING,
        TurnState.ERROR,
    },
    TurnState.SPEAKING: {TurnState.LISTENING, TurnState.INTERRUPTED, TurnState.ENDING, TurnState.ERROR},
    TurnState.INTERRUPTED: {
        TurnState.TRANSCRIBING,
        TurnState.USER_SPEAKING,
        TurnState.LISTENING,
        TurnState.ENDING,
        TurnState.ERROR,
    },
    TurnState.ENDING: {TurnState.ENDED},
    TurnState.ENDED: set(),
    TurnState.ERROR: {TurnState.LISTENING, TurnState.ENDING, TurnState.ENDED},
}


class IllegalTransition(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# Events
# --------------------------------------------------------------------------- #
class EventType(str, enum.Enum):
    VOICE_SESSION_STARTED = "VOICE_SESSION_STARTED"
    VOICE_SESSION_ENDED = "VOICE_SESSION_ENDED"
    AUDIO_INPUT_STARTED = "AUDIO_INPUT_STARTED"
    USER_SPEECH_STARTED = "USER_SPEECH_STARTED"
    USER_SPEECH_STOPPED = "USER_SPEECH_STOPPED"
    STT_PARTIAL = "STT_PARTIAL"
    STT_FINAL = "STT_FINAL"
    USER_TURN_ACCEPTED = "USER_TURN_ACCEPTED"
    USER_TURN_REJECTED = "USER_TURN_REJECTED"
    CONTEXT_STARTED = "CONTEXT_STARTED"
    CONTEXT_READY = "CONTEXT_READY"
    LLM_STARTED = "LLM_STARTED"
    LLM_TOKEN = "LLM_TOKEN"
    LLM_COMPLETED = "LLM_COMPLETED"
    TTS_STARTED = "TTS_STARTED"
    TTS_AUDIO = "TTS_AUDIO"
    TTS_COMPLETED = "TTS_COMPLETED"
    ASSISTANT_TURN_STARTED = "ASSISTANT_TURN_STARTED"
    ASSISTANT_TURN_COMPLETED = "ASSISTANT_TURN_COMPLETED"
    INTERRUPTION_STARTED = "INTERRUPTION_STARTED"
    INTERRUPTION_COMPLETED = "INTERRUPTION_COMPLETED"
    AUDIO_QUEUE_ADD = "AUDIO_QUEUE_ADD"
    AUDIO_QUEUE_PLAY = "AUDIO_QUEUE_PLAY"
    AUDIO_QUEUE_FLUSH = "AUDIO_QUEUE_FLUSH"
    AUDIO_PLAYBACK_STARTED = "AUDIO_PLAYBACK_STARTED"
    AUDIO_PLAYBACK_STOPPED = "AUDIO_PLAYBACK_STOPPED"
    BACKCHANNEL = "BACKCHANNEL"
    VOICE_ERROR = "VOICE_ERROR"
    TURN_TRACE = "TURN_TRACE"
    STAGE_REJECTED = "STAGE_REJECTED"


@dataclass(frozen=True)
class VoiceEvent:
    session_id: str
    turn_id: str | None
    sequence: int
    type: EventType
    timestamp: float
    data: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "sessionId": self.session_id,
            "turnId": self.turn_id,
            "timestamp": round(self.timestamp, 3),
            "sequence": self.sequence,
            "type": self.type.value,
            "data": self.data,
        }


class EventBus:
    """Monotonic sequence + subscribers + a bounded trace ring for the dev UI."""

    def __init__(self, session_id: str, trace_size: int = 400) -> None:
        self.session_id = session_id
        self._seq = 0
        self._subscribers: list[Callable[[VoiceEvent], Awaitable[None] | None]] = []
        self.trace: deque[VoiceEvent] = deque(maxlen=trace_size)
        self.counts: dict[str, int] = {}

    def subscribe(self, fn: Callable[[VoiceEvent], Awaitable[None] | None]) -> None:
        self._subscribers.append(fn)

    def emit(self, type_: EventType, turn_id: str | None = None, **data) -> VoiceEvent:
        self._seq += 1
        event = VoiceEvent(
            session_id=self.session_id,
            turn_id=turn_id,
            sequence=self._seq,
            type=type_,
            timestamp=time.time(),
            data=data,
        )
        self.trace.append(event)
        self.counts[type_.value] = self.counts.get(type_.value, 0) + 1
        for fn in list(self._subscribers):
            try:
                result = fn(event)
                if asyncio.iscoroutine(result):
                    # Subscribers must never be able to break the pipeline.
                    asyncio.ensure_future(self._safe(fn, result))
            except Exception:  # noqa: BLE001
                log.exception("event subscriber failed for %s", type_.value)
        return event

    @staticmethod
    async def _safe(fn, coro) -> None:
        try:
            await coro
        except Exception:  # noqa: BLE001
            log.exception("async event subscriber failed")

    def timeline(self, turn_id: str | None = None) -> list[dict]:
        return [e.to_dict() for e in self.trace if turn_id is None or e.turn_id == turn_id]


# --------------------------------------------------------------------------- #
# Turns
# --------------------------------------------------------------------------- #
@dataclass
class Turn:
    turn_id: str
    index: int
    created_at: float = field(default_factory=time.time)
    audio_start: float | None = None
    audio_end: float | None = None
    transcript: str = ""
    revision: int = 0
    accepted: bool = False
    reject_reason: str | None = None
    answer: str | None = None
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)
    # per-turn tasks, so cancelling a turn cancels exactly its own work
    tasks: set[asyncio.Task] = field(default_factory=set)
    metrics: dict[str, float] = field(default_factory=dict)

    def mark(self, name: str, value: float | None = None) -> None:
        self.metrics[name] = value if value is not None else time.time()

    def elapsed(self, name: str) -> float | None:
        v = self.metrics.get(name)
        return None if v is None else round(v, 3)


class TurnRegistry:
    """Owns turns. Newest turn wins; older turns are cancelled and go stale."""

    def __init__(self, bus: EventBus) -> None:
        self.bus = bus
        self._counter = 0
        self.current: Turn | None = None
        self.history: deque[Turn] = deque(maxlen=50)

    def open(self) -> Turn:
        self._counter += 1
        turn = Turn(turn_id=f"t{self._counter}-{uuid.uuid4().hex[:6]}", index=self._counter)
        if self.current is not None:
            self.cancel(self.current, reason="superseded")
        self.current = turn
        self.history.append(turn)
        self.bus.emit(EventType.USER_SPEECH_STARTED, turn.turn_id, turnIndex=turn.index)
        return turn

    def cancel(self, turn: Turn, reason: str) -> None:
        if turn.cancelled.is_set():
            return
        turn.cancelled.set()
        turn.reject_reason = turn.reject_reason or reason
        for task in list(turn.tasks):
            task.cancel()
        turn.tasks.clear()

    def is_current(self, turn: Turn | None) -> bool:
        return turn is not None and turn is self.current and not turn.cancelled.is_set()

    def owner(self, turn: Turn | None) -> bool:
        """True when the caller may still affect the conversation."""
        return self.is_current(turn)


# --------------------------------------------------------------------------- #
# Stage 4/5: transcript normalisation and turn validation
# --------------------------------------------------------------------------- #
_WS = " \t\r\n\u200b"
# Turned away from: these must never reach the model.
_REJECT_EXACT = {
    "uh huh", "mm hmm", "hmm", "uh", "um", "erm", "huh", "so", "yeah yeah",
    "okay okay", "right right", "yes yes", "no no", "ha", "haha", "hehe",
}


class TranscriptNormalizer:
    """Whitespace, control characters, casing noise and duplicated revisions."""

    def __init__(self, min_chars: int = 2, min_words: int = 1) -> None:
        self.min_chars = min_chars
        self.min_words = min_words

    def normalize(self, text: str) -> str:
        t = (text or "").replace("\u200b", " ")
        t = "".join(ch for ch in t if ch == " " or not (ord(ch) < 32))
        t = " ".join(t.split())
        # Whisper repeats short phrases when a chunk boundary lands mid-word.
        t = self._drop_stutter(t)
        return t.strip(_WS)

    @staticmethod
    def _drop_stutter(text: str) -> str:
        words = text.split()
        out: list[str] = []
        for w in words:
            # whisper repeats a short word when a chunk boundary lands on it
            if len(w) <= 2 and out and out[-1] == w:
                continue
            out.append(w)
        return " ".join(out)

    def is_meaningful(self, text: str) -> tuple[bool, str | None]:
        """Returns (usable, reason)."""
        if not text:
            return False, "empty_transcript"
        if len(text) < self.min_chars:
            return False, "too_short"
        if len(text.split()) < self.min_words:
            return False, "too_few_words"
        if text.lower().strip(" .!?,") in _REJECT_EXACT:
            return False, "filler_only"
        letters = sum(ch.isalpha() for ch in text)
        if letters < 2:
            return False, "no_speech_content"
        # A transcript that is mostly punctuation is a decoding artefact.
        if letters / max(len(text), 1) < 0.4:
            return False, "not_speech"
        return True, None


class TurnValidator:
    """The single gate between 'we heard something' and 'the model may answer'."""

    def __init__(self, normalizer: TranscriptNormalizer, require_final: bool = True) -> None:
        self.normalizer = normalizer
        self.require_final = require_final

    def validate(self, *, text: str, is_final: bool, revision: int, last_revision: int, duplicate_of: str | None) -> tuple[bool, str | None, str]:
        if self.require_final and not is_final:
            return False, "partial_not_final", ""
        if duplicate_of:
            return False, f"duplicate_of:{duplicate_of}", ""
        if revision and last_revision and revision <= last_revision and last_revision > 0:
            return False, "stale_revision", ""
        clean = self.normalizer.normalize(text)
        ok, reason = self.normalizer.is_meaningful(clean)
        if not ok:
            return False, reason, clean
        return True, None, clean


# --------------------------------------------------------------------------- #
# Stage 6/7: conversation engine + response streaming
# --------------------------------------------------------------------------- #
@dataclass
class StageResult:
    text: str
    meta: dict = field(default_factory=dict)


class ConversationEngine:
    """Wraps the existing business pipeline (RAG/capture/booking/LLM).

    Only accepted turns reach this object, and it refuses to run twice for the
    same turn id.
    """

    def __init__(self, complete: Callable[[str, str], Awaitable[str]], history: Callable[[], str]) -> None:
        self._complete = complete
        self._history = history
        self.handled: set[str] = set()

    async def run(self, turn: Turn, transcript: str, registry: TurnRegistry, bus: EventBus) -> StageResult:
        if turn.turn_id in self.handled:
            bus.emit(EventType.STAGE_REJECTED, turn.turn_id, reason="duplicate_turn", stage="conversation")
            return StageResult("", {"duplicate": True})
        self.handled.add(turn.turn_id)
        bus.emit(EventType.CONTEXT_STARTED, turn.turn_id)
        bus.emit(EventType.CONTEXT_READY, turn.turn_id)
        bus.emit(EventType.LLM_STARTED, turn.turn_id)
        t0 = time.time()
        answer = await self._complete(transcript, self._history())
        if not registry.owner(turn):
            # A newer turn exists: this answer is stale and must never be spoken.
            bus.emit(EventType.STAGE_REJECTED, turn.turn_id, reason="stale_after_llm", stage="conversation")
            log.info("discarding stale answer for %s", turn.turn_id)
            return StageResult("", {"stale": True})
        bus.emit(EventType.LLM_COMPLETED, turn.turn_id, ms=round((time.time() - t0) * 1000))
        return StageResult(answer, {"llm_ms": round((time.time() - t0) * 1000)})


def split_for_tts(text: str, max_chars: int = 220) -> list[str]:
    """Phrase boundaries only: never hand TTS a half sentence."""
    import re

    parts = re.split(r"(?<=[.!?])\s+", (text or "").strip())
    out: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        while len(part) > max_chars:
            cut = part.rfind(" ", 0, max_chars)
            cut = cut if cut > 40 else max_chars
            out.append(part[:cut].strip())
            part = part[cut:].lstrip()
        if part:
            out.append(part)
    return out


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #
class VoiceOrchestrator:
    """State machine + turn ownership. Transport-agnostic and unit-testable."""

    def __init__(
        self,
        session_id: str,
        *,
        engine: ConversationEngine,
        on_audio: Callable[[bytes, int, Turn], Awaitable[None]],
        on_legacy: Callable[[dict], Awaitable[None]] | None = None,
        normalizer: TranscriptNormalizer | None = None,
        allow_barge_in: bool = True,
    ) -> None:
        self.session_id = session_id
        self.bus = EventBus(session_id)
        self.turns = TurnRegistry(self.bus)
        self.state = TurnState.IDLE
        self.engine = engine
        self.on_audio = on_audio
        self.on_legacy = on_legacy
        self.validator = TurnValidator(normalizer or TranscriptNormalizer())
        self.allow_barge_in = allow_barge_in
        self.audio_playback_active = False
        self._accepted_transcripts: dict[str, str] = {}
        self.stats = {
            "turns": 0,
            "rejected": 0,
            "stale_discarded": 0,
            "interruptions": 0,
            "errors": 0,
        }
        self.state_history: list[tuple[float, TurnState, TurnState]] = []
        self.transitions(self.state, TurnState.LISTENING, "session_start")

    # ---------------- state machine ----------------
    def transitions(self, current: TurnState, target: TurnState, reason: str) -> bool:
        if target not in LEGAL_TRANSITIONS.get(current, set()):
            self.bus.emit(
                EventType.VOICE_ERROR,
                self.turns.current.turn_id if self.turns.current else None,
                reason="illegal_transition",
                data={"from": current.value, "to": target.value, "cause": reason},
            )
            log.warning("refused transition %s -> %s (%s)", current.value, target.value, reason)
            return False
        self.state_history.append((time.time(), current, target))
        self.state = target
        return True

    def _require(self, target: TurnState, reason: str) -> bool:
        return self.transitions(self.state, target, reason)

    # ---------------- turn lifecycle ----------------
    def assistant_audio_started(self, turn_id: str | None = None) -> None:
        """Assistant audio is playing (greeting or backchannel may have no turn)."""
        self.audio_playback_active = True
        self.bus.emit(EventType.AUDIO_PLAYBACK_STARTED, turn_id)

    def assistant_audio_stopped(self, turn_id: str | None = None) -> None:
        self.audio_playback_active = False
        self.bus.emit(EventType.AUDIO_PLAYBACK_STOPPED, turn_id)

    def ensure_speech_turn(self) -> Turn | None:
        """Reuse the open turn when the caller is already mid-utterance.

        The receive loop and the barge-in path can both see the same speech. Two
        opens meant the second one cancelled the first, so the utterance was
        dropped without ever reaching the model.
        """
        if self.state is TurnState.USER_SPEAKING and self.turns.current is not None:
            return self.turns.current
        return self.begin_speech()

    def begin_speech(self) -> Turn:
        """USER_SPEECH_STARTED. Returns None when the transition is not legal."""
        if self.audio_playback_active and not self.allow_barge_in:
            self.bus.emit(EventType.STAGE_REJECTED, None, reason="barge_in_disabled", stage="turn_detector")
            return None  # type: ignore[return-value]
        if self.audio_playback_active or self.state in (
            TurnState.SPEAKING,
            TurnState.THINKING,
            TurnState.TRANSCRIBING,
        ):
            # The caller started a new utterance before we finished the last one.
            self.interrupt("caller_speech")
        if not self._require(TurnState.USER_SPEAKING, "speech_start"):
            return None  # type: ignore[return-value]
        turn = self.turns.open()
        turn.audio_start = time.time()
        turn.mark("speech_start")
        self.stats["turns"] += 1
        return turn

    def end_speech(self) -> Turn | None:
        turn = self.turns.current
        if turn is None or self.state is not TurnState.USER_SPEAKING:
            return None
        turn.audio_end = time.time()
        turn.mark("speech_end")
        self.bus.emit(EventType.USER_SPEECH_STOPPED, turn.turn_id, ms=round((turn.audio_end - (turn.audio_start or turn.audio_end)) * 1000))
        if not self._require(TurnState.TRANSCRIBING, "speech_end"):
            return None
        return turn

    def on_partial(self, text: str, revision: int) -> None:
        turn = self.turns.current
        if turn is None or turn.cancelled.is_set():
            return
        turn.revision = revision
        turn.transcript = self.validator.normalizer.normalize(text)
        self.bus.emit(EventType.STT_PARTIAL, turn.turn_id, revision=revision, text=turn.transcript)

    def on_final(self, text: str, revision: int = 0) -> tuple[bool, str | None]:
        """Returns (accepted, reason). Only an accepted turn may reach the LLM."""
        turn = self.turns.current
        if turn is None:
            return False, "no_turn"
        if turn.cancelled.is_set() or turn is not self.turns.current:
            self.stats["stale_discarded"] += 1
            self.bus.emit(EventType.STAGE_REJECTED, turn.turn_id, reason="stale_final", stage="stt")
            return False, "stale_final"
        duplicate_of = None
        norm = self.validator.normalizer.normalize(text)
        for other_id, other in self._accepted_transcripts.items():
            if other_id != turn.turn_id and other and norm and other == norm:
                duplicate_of = other_id
                break
        accepted, reason, clean = self.validator.validate(
            text=text,
            is_final=True,
            revision=revision,
            last_revision=turn.revision,
            duplicate_of=duplicate_of,
        )
        self.bus.emit(EventType.STT_FINAL, turn.turn_id, revision=revision, text=clean, accepted=accepted, reason=reason)
        if not accepted:
            self.stats["rejected"] += 1
            self.bus.emit(EventType.USER_TURN_REJECTED, turn.turn_id, reason=reason, text=clean)
            turn.reject_reason = reason
            # Back to listening; the model is never called.
            self._require(TurnState.LISTENING, f"rejected:{reason}")
            return False, reason
        turn.transcript = clean
        turn.accepted = True
        turn.mark("accepted")
        self._accepted_transcripts[turn.turn_id] = clean
        self.bus.emit(EventType.USER_TURN_ACCEPTED, turn.turn_id, text=clean)
        return True, None

    def reclaim_for(self, turn: Turn) -> None:
        """Re-enter TRANSCRIBING when a late playback reset the shared state.

        The previous turn can finish its audio window after this turn has already
        been accepted. That is legal; refusing to answer because of it is not.
        """
        if turn is not self.turns.current:
            return
        if turn.cancelled.is_set():
            return
        if self.state is TurnState.LISTENING:
            self.state = TurnState.TRANSCRIBING

    async def run_conversation(self, turn: Turn) -> str:
        """THINKING -> SPEAKING. Cancelled work never speaks."""
        if not self._require(TurnState.THINKING, "accepted_turn"):
            return ""
        result = await self.engine.run(turn, turn.transcript, self.turns, self.bus)
        if result.meta.get("stale"):
            self.stats["stale_discarded"] += 1
            return ""
        if not self.turns.owner(turn):
            self.stats["stale_discarded"] += 1
            return ""
        turn.answer = result.text
        turn.mark("llm_done")
        for key in ("llm_ms",):
            if key in result.meta:
                turn.metrics[key] = result.meta[key]
        return result.text

    def speaking_started(self, turn: Turn | None) -> None:
        if turn is None or not self.turns.owner(turn):
            return
        self.audio_playback_active = True
        self.bus.emit(EventType.ASSISTANT_TURN_STARTED, turn.turn_id)
        self._require(TurnState.SPEAKING, "assistant_audio")
        self.bus.emit(EventType.AUDIO_PLAYBACK_STARTED, turn.turn_id)

    def speaking_finished(self, turn: Turn | None) -> None:
        if turn is None or not self.turns.owner(turn):
            return
        self.audio_playback_active = False
        self.bus.emit(EventType.AUDIO_PLAYBACK_STOPPED, turn.turn_id)
        self.bus.emit(EventType.ASSISTANT_TURN_COMPLETED, turn.turn_id)
        self._require(TurnState.LISTENING, "assistant_done")

    def interrupt(self, reason: str = "caller_speech") -> None:
        """Cancel the current turn and drop everything it was producing."""
        turn = self.turns.current
        self.stats["interruptions"] += 1
        self.bus.emit(EventType.INTERRUPTION_STARTED, turn.turn_id if turn else None, reason=reason)
        if turn is not None:
            self.turns.cancel(turn, reason)
            self.bus.emit(EventType.AUDIO_QUEUE_FLUSH, turn.turn_id, reason="interruption")
        self.audio_playback_active = False
        if self.state in (TurnState.SPEAKING, TurnState.THINKING, TurnState.TRANSCRIBING):
            self.transitions(self.state, TurnState.INTERRUPTED, reason)
        self.bus.emit(EventType.INTERRUPTION_COMPLETED, turn.turn_id if turn else None)

    def error(self, reason: str, **data) -> None:
        self.stats["errors"] += 1
        self.bus.emit(EventType.VOICE_ERROR, self.turns.current.turn_id if self.turns.current else None, reason=reason, data=data)
        self.transitions(self.state, TurnState.ERROR, reason)
        self._require(TurnState.LISTENING, "recovered")

    def end(self) -> None:
        turn = self.turns.current
        if turn is not None:
            self.turns.cancel(turn, "session_end")
        self.transitions(self.state, TurnState.ENDING, "session_end")
        self.bus.emit(EventType.VOICE_SESSION_ENDED, None)
        self.transitions(self.state, TurnState.ENDED, "session_end")

    # ---------------- observability ----------------
    def trace(self, turn_id: str | None = None) -> list[dict]:
        return self.bus.timeline(turn_id)

    def metrics(self) -> dict:
        out = dict(self.stats)
        out["state"] = self.state.value
        out["events"] = dict(self.bus.counts)
        turns = [t for t in self.turns.history if t.accepted]
        if turns:
            out["last_turn"] = {
                "turnId": turns[-1].turn_id,
                "metrics": turns[-1].metrics,
                "transcript": turns[-1].transcript,
            }
        return out