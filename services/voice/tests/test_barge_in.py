"""Regression tests for the "two voices" failure.

The agent used to transcribe its own speaker output, treat it as a new user
turn, and answer while the previous reply was still playing. These tests pin the
half-duplex rules that prevent it.
"""
from __future__ import annotations

import asyncio
import json
import math
import struct

import pytest

from voice_agent import server as srv
from voice_agent.server import FRAME_BYTES, Session
from voice_agent.vad import Vad, VadConfig


def frame(ms: int, amp: float, sr: int = 16000) -> bytes:
    n = int(sr * ms / 1000)
    return b"".join(
        struct.pack("<h", int(max(-1.0, min(1.0, amp * math.sin(i / 6.0))) * 32767))
        for i in range(n)
    )


class FakeWS:
    """Collects everything the session sends, and replays a scripted input."""

    def __init__(self, script: list[bytes | str]):
        self.script = list(script)
        self.sent: list[bytes | str] = []
        self.closed = False
        self.gate: asyncio.Event | None = None

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.script:
            raise StopAsyncIteration
        if self.gate is not None:
            await self.gate.wait()
            self.gate = None
        item = self.script.pop(0)
        await asyncio.sleep(0)
        return item

    async def send(self, data):
        self.sent.append(data)

    async def close(self):
        self.closed = True

    def events(self) -> list[dict]:
        out = []
        for item in self.sent:
            if isinstance(item, str):
                out.append(json.loads(item))
        return out

    def types(self) -> list[str]:
        return [e.get("type") for e in self.events()]

    def audio_bytes(self) -> int:
        return sum(len(i) for i in self.sent if isinstance(i, bytes))


class StubPipeline:
    class _State:
        def __init__(self) -> None:
            self.items: list[dict] = []

        def add(self, role: str, content: str) -> None:
            self.items.append({"role": role, "content": content})

        def history_text(self, last: int = 20) -> str:
            return ""

    class _LLM:
        async def complete(self, system: str, context: str, user: str, draft: bool = False) -> str:
            return "Got it."

    def __init__(self):
        self.barge_ins = 0
        self.turns: list[str] = []
        self.state = self._State()
        self.llm = self._LLM()

    async def synthesize(self, text: str):
        await asyncio.sleep(0.02)  # real TTS takes time; let the test interleave
        class C:
            pcm16 = b"\x00\x01" * 8000
            sample_rate = 16000

        return C()

    def handle_barge_in(self) -> None:
        self.barge_ins += 1

    async def transcribe(self, pcm: bytes):
        return await srv._stt.transcribe(pcm)

    async def handle_text(self, text: str, on_transcript=None):
        self.turns.append(text)
        if on_transcript:
            await on_transcript(text)
        return "Got it."

    async def handle_audio(self, pcm: bytes, on_transcript=None):
        self.turns.append("<audio>")
        return "Got it."


class StubTTS:
    name = "stub-tts"

    def __init__(self):
        self.backup = None

    async def synthesize(self, text: str):
        class C:
            pcm16 = b"\x00\x01" * 4000
            sample_rate = 16000

        return C()


class StubSTT:
    """Mirrors the real provider contract: transcribe() returns the text."""

    name = "stub"

    async def transcribe(self, pcm: bytes, sr: int = 16000) -> str:
        return "are you still there"


async def _session(script: list[bytes | str]) -> tuple[Session, FakeWS, StubPipeline]:
    ws = FakeWS(script)
    session = Session(ws)
    session.started = True  # skip auth/startup
    session.pipeline = StubPipeline()
    session.vad = Vad(VadConfig(barge_in_ms=280), 16000)
    return session, ws, session.pipeline


@pytest.mark.asyncio
async def test_short_blips_while_speaking_are_ignored(monkeypatch):
    monkeypatch.setattr(srv, "_stt", StubSTT())
    # our audio is playing; the room produces short bursts (door, cough, keyboard)
    script: list[bytes | str] = [b""] + [frame(150, 0.3) + frame(300, 0.0)] * 6
    session, ws, pipeline = await _session(script)
    session.speaking = True
    session._echo_guard_frames = 0  # guard already expired: blips still must not count
    await session.run()
    assert pipeline.barge_ins == 0
    assert "interrupted" not in ws.types()
    assert session.queue.empty()


@pytest.mark.asyncio
async def test_sustained_caller_speech_interrupts_exactly_once(monkeypatch):
    monkeypatch.setattr(srv, "_stt", StubSTT())
    session, ws, pipeline = await _session([frame(1500, 0.3)])
    session.speaking = True
    session._echo_guard_frames = 0
    await session.run()
    assert pipeline.barge_ins == 1  # once, not once per frame
    assert ws.types().count("interrupted") == 1
    assert session.interrupted is True
    # the caller's words are kept for transcription, not thrown away
    assert len(session.vad.peek()) > 0


@pytest.mark.asyncio
async def test_barge_in_utterance_is_queued_once_when_audio_stops(monkeypatch):
    monkeypatch.setattr(srv, "_stt", StubSTT())
    session, ws, pipeline = await _session([])
    session.speaking = True
    session._echo_guard_frames = 0
    # the caller talks over us, entirely through the receive loop
    ws.script = [frame(700, 0.3)]
    await session.run()
    assert pipeline.barge_ins == 1
    session.speaking = False  # our audio finished
    ws.script = [frame(800, 0.0)]  # caller stops talking
    await session.run()
    assert session.queue.qsize() == 1


@pytest.mark.asyncio
async def test_echo_onset_inside_guard_window_is_dropped(monkeypatch):
    """Bleed that starts with our audio and is over quickly must be ignored."""
    monkeypatch.setattr(srv, "_stt", StubSTT())
    session, ws, pipeline = await _session([frame(300, 0.3)])
    session.speaking = True
    session._echo_guard_frames = srv.ECHO_GUARD_FRAMES  # playback just started
    await session.run()
    assert pipeline.barge_ins == 0
    assert "interrupted" not in ws.types()


@pytest.mark.asyncio
async def test_guard_counts_audio_time_not_wall_clock(monkeypatch):
    """Bursty/buffered caller audio must not be swallowed by the echo guard."""
    monkeypatch.setattr(srv, "_stt", StubSTT())
    session, ws, pipeline = await _session([frame(1500, 0.3)])
    session.speaking = True
    session._echo_guard_frames = srv.ECHO_GUARD_FRAMES
    await session.run()  # delivered instantly: wall-clock never advances
    assert pipeline.barge_ins == 1


@pytest.mark.asyncio
async def test_normal_turn_after_speech_ends(monkeypatch):
    monkeypatch.setattr(srv, "_stt", StubSTT())
    loud = frame(600, 0.3)
    quiet = frame(800, 0.0)
    session, ws, pipeline = await _session([loud, quiet, loud, quiet])
    await session.run()
    # endpoint detected -> utterance queued, and "hearing" told the UI to react
    assert "hearing" in ws.types()
    assert not session.queue.empty()


@pytest.mark.asyncio
async def test_speak_sets_and_clears_half_duplex_state():
    session, ws, pipeline = await _session([])
    await session._speak("Hello there.")
    types = ws.types()
    assert "speak_start" in types and "speak_end" in types
    assert session.speaking is False
    assert ws.audio_bytes() > 0


@pytest.mark.asyncio
async def test_idle_watchdog_nudges_then_hangs_up(monkeypatch):
    import time as _time

    clock = {"now": 1000.0}
    monkeypatch.setattr(_time, "time", lambda: clock["now"])

    session, ws, _ = await _session([])
    session.started = True
    session.last_activity = clock["now"]
    session.call_started = clock["now"]

    real_sleep = asyncio.sleep

    async def fake_sleep(_):
        clock["now"] += 20.0  # each tick jumps 20 s of silence
        await real_sleep(0)  # still yield so the task can make progress

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    task = asyncio.create_task(session._watchdog())
    for _ in range(4):
        await asyncio.sleep(0)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    spoken = [e for e in ws.events() if e.get("type") in ("speak_start", "audio_start")]
    assert spoken, "watchdog should speak at least once on silence"
    assert session.idle_nudges == 1


def test_frame_bytes_is_20ms_at_16k():
    assert FRAME_BYTES == 16000 * 2 * 0.02

@pytest.mark.asyncio
async def test_words_spoken_during_our_audio_are_not_lost(monkeypatch):
    """The caller talked over our audio; their words must still be answered."""
    monkeypatch.setattr(srv, "_stt", StubSTT())
    monkeypatch.setattr(srv, "_tts", StubTTS())
    session, ws, pipeline = await _session([])
    # trailing silence so the endpoint closes the utterance after our audio stops
    ws.script = [frame(1500, 0.3) + frame(700, 0.0)]
    ws.gate = asyncio.Event()  # hold the caller's words until we are speaking
    runner = asyncio.create_task(session.run())
    # a multi-sentence greeting so "speaking" lasts long enough to interrupt
    greeting = asyncio.create_task(
        session._speak("Hello there. Thanks for calling. How can I help you today.")
    )
    for _ in range(400):
        if session.speaking:
            break
        await asyncio.sleep(0.001)
    assert session.speaking is True
    ws.gate.set()  # caller starts talking over the agent
    await asyncio.wait_for(greeting, timeout=5)
    await asyncio.wait_for(runner, timeout=5)
    assert pipeline.barge_ins == 1
    assert session.speaking is False
    # their words were queued for an answer instead of discarded
    assert session.queue.qsize() == 1
    kind, _payload, _turn = session.queue.get_nowait()
    assert kind.startswith("audio")


@pytest.mark.asyncio
async def test_turn_is_closed_when_the_client_stops_sending_audio(monkeypatch):
    """No trailing silence frames must not leave the caller hanging."""
    monkeypatch.setattr(srv, "_stt", StubSTT())
    session, ws, pipeline = await _session([frame(800, 0.3)])
    await session.run()  # audio ends, VAD is still waiting for silence
    assert session.vad.in_speech is True
    assert session.queue.empty()
    # the client went quiet without sending silence
    session._last_frame_at -= 5.0
    watcher = asyncio.create_task(session._turn_watchdog())
    for _ in range(80):
        if not session.queue.empty():
            break
        await asyncio.sleep(0.01)
    watcher.cancel()
    try:
        await watcher
    except asyncio.CancelledError:
        pass
    assert session.queue.qsize() == 1
    assert session.vad.in_speech is False


@pytest.mark.asyncio
async def test_stale_turn_watchdog_ignores_a_healthy_stream(monkeypatch):
    monkeypatch.setattr(srv, "_stt", StubSTT())
    session, ws, pipeline = await _session([frame(400, 0.3)])
    session.vad.feed(frame(200, 0.3))
    assert session.vad.in_speech is True
    watcher = asyncio.create_task(session._turn_watchdog())
    await asyncio.sleep(0.4)  # audio is still "arriving"
    watcher.cancel()
    try:
        await watcher
    except asyncio.CancelledError:
        pass
    assert session.queue.empty()


@pytest.mark.asyncio
async def test_stays_armed_while_the_client_is_still_playing(monkeypatch):
    """The client buffers audio, so we are speaking until playback finishes."""
    monkeypatch.setattr(srv, "_stt", StubSTT())
    session, ws, pipeline = await _session([])
    await session._speak("Hello there.")
    seconds = ws.audio_bytes() / (16000 * 2)
    assert 0.4 <= seconds <= 2.0  # about half a second of speech
    assert session.speaking is False  # released after the playback window


@pytest.mark.asyncio
async def test_playback_window_keeps_barge_in_armed(monkeypatch):
    monkeypatch.setattr(srv, "_stt", StubSTT())
    session, ws, pipeline = await _session([])
    task = asyncio.create_task(session._speak("One two three four five."))
    # while the client would still be playing, a caller must be able to interrupt
    for _ in range(200):
        if session.speaking:
            break
        await asyncio.sleep(0.005)
    assert session.speaking is True
    assert pipeline.barge_ins == 0
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


class RecordingSTT:
    """STT stub that records what it was asked to transcribe."""

    name = "recording"

    def __init__(self) -> None:
        self.seen: list[int] = []
        self.text = "Actually, tell me about the enterprise plan instead."

    async def transcribe(self, pcm: bytes, sr: int = 16000) -> str:
        self.seen.append(len(pcm))
        return "Actually, tell me about the enterprise plan instead."


@pytest.mark.asyncio
async def test_final_transcript_covers_the_whole_utterance(monkeypatch):
    """Regression: take() reset the VAD before the final pass, so the answer was
    only the last partial and got cut mid-sentence."""
    stt = RecordingSTT()
    monkeypatch.setattr(srv, "_stt", stt)
    session, ws, pipeline = await _session([frame(1500, 0.3), frame(600, 0.0)])
    await session.run()
    assert session.queue.qsize() == 1
    kind, _pcm, _turn = session.queue.get_nowait()
    assert kind == "audio-draft"
    # the whole utterance reached the recogniser, not just the trailing delta
    assert max(stt.seen) >= 1500 * 16000 // 1000 * 2
    assert session.hypothesis == "Actually, tell me about the enterprise plan instead."


@pytest.mark.asyncio
async def test_interruption_transcript_covers_the_whole_utterance(monkeypatch):
    stt = RecordingSTT()
    monkeypatch.setattr(srv, "_stt", stt)
    monkeypatch.setattr(srv, "_tts", StubTTS())
    session, ws, pipeline = await _session([])
    ws.script = [frame(1500, 0.3) + frame(700, 0.0)]
    ws.gate = asyncio.Event()
    runner = asyncio.create_task(session.run())
    greeting = asyncio.create_task(
        session._speak("Hello there. Thanks for calling. How can I help you today.")
    )
    for _ in range(400):
        if session.speaking:
            break
        await asyncio.sleep(0.001)
    ws.gate.set()
    await asyncio.wait_for(greeting, timeout=5)
    await asyncio.wait_for(runner, timeout=5)
    assert session.queue.qsize() == 1
    assert max(stt.seen) >= 1000 * 16000 // 1000 * 2


@pytest.mark.asyncio
async def test_caller_who_keeps_talking_is_captured_whole(monkeypatch):
    """Regression: flushing at speak_end answered only the first word."""
    stt = RecordingSTT()
    monkeypatch.setattr(srv, "_stt", stt)
    monkeypatch.setattr(srv, "_tts", StubTTS())
    session, ws, pipeline = await _session([])
    # 0.6 s of speech, we stop talking, then 1.2 s more from the caller
    ws.script = [frame(600, 0.3), frame(1200, 0.3), frame(700, 0.0)]
    ws.gate = asyncio.Event()
    runner = asyncio.create_task(session.run())
    greeting = asyncio.create_task(
        session._speak("Hello there. Thanks for calling. How can I help you today.")
    )
    for _ in range(400):
        if session.speaking:
            break
        await asyncio.sleep(0.001)
    ws.gate.set()
    await asyncio.wait_for(greeting, timeout=5)
    await asyncio.wait_for(runner, timeout=5)
    assert pipeline.barge_ins == 1
    # one utterance, containing everything the caller said
    assert session.queue.qsize() == 1
    _kind, payload, _turn = session.queue.get_nowait()
    spoken_ms = len(payload) / (16000 * 2) * 1000
    assert spoken_ms >= 1700, f"only {spoken_ms:.0f} ms captured"
    assert session.hypothesis == "Actually, tell me about the enterprise plan instead."


def test_backchannel_suppressed_for_greetings():
    for t in ["hello", "Hello.", "hi there", "yes", "okay", "thanks", "thank you", "no", ""]:
        assert srv._wants_backchannel(t) is False, t


def test_backchannel_kept_for_real_questions():
    for t in [
        "how much does the growth plan cost",
        "I want to book an appointment tomorrow",
        "can you tell me about the enterprise plan",
    ]:
        assert srv._wants_backchannel(t) is True, t


@pytest.mark.asyncio
async def test_session_start_never_drops_the_socket_silently(monkeypatch):
    """A failure during start() must reach the client, not close the socket."""
    session, ws, _ = await _session([])
    monkeypatch.setattr(
        srv.ApiLLM, "__init__", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    )
    await session.start({"token": "t", "workspaceId": "w"})
    kinds = [e.get("type") for e in ws.events()]
    assert "error" in kinds
    err = next(e for e in ws.events() if e.get("type") == "error")
    assert err.get("reason") == "start_failed"


@pytest.mark.asyncio
async def test_barge_in_opens_a_turn_for_the_interrupting_speech(monkeypatch):
    """Regression: speech over the agent had no turn owner, so it was dropped."""
    stt = RecordingSTT()
    monkeypatch.setattr(srv, "_stt", stt)
    monkeypatch.setattr(srv, "_tts", StubTTS())
    session, ws, pipeline = await _session([])
    session._build_orchestrator()
    session.started = True
    ws.script = [frame(1500, 0.3) + frame(700, 0.0)]
    ws.gate = asyncio.Event()
    runner = asyncio.create_task(session.run())
    greeting = asyncio.create_task(
        session._speak("Hello there. Thanks for calling. How can I help you today.")
    )
    for _ in range(400):
        if session.speaking:
            break
        await asyncio.sleep(0.001)
    ws.gate.set()
    await asyncio.wait_for(greeting, timeout=5)
    await asyncio.wait_for(runner, timeout=5)
    assert session.orch is not None
    assert session.orch.stats["turns"] >= 1
    assert session.orch.stats["interruptions"] >= 1
    # the interrupted speech is queued with an owner
    assert session.queue.qsize() == 1
    _kind, _pcm, turn = session.queue.get_nowait()
    assert turn is not None and turn.turn_id
