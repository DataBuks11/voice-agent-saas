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
    def __init__(self):
        self.barge_ins = 0
        self.turns: list[str] = []

    async def synthesize(self, text: str):
        await asyncio.sleep(0.02)  # real TTS takes time; let the test interleave
        class C:
            pcm16 = b"\x00\x01" * 8000
            sample_rate = 16000

        return C()

    def handle_barge_in(self) -> None:
        self.barge_ins += 1

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
    name = "stub"

    async def transcribe(self, pcm: bytes, sr: int):
        class R:
            text = "are you still there"

        return R()


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
    session.vad.feed(frame(700, 0.3))
    session._echo_candidate = True
    # the barge-in is detected on the next frame and latched
    ws.script = [frame(100, 0.3)]
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
    ws.script = [frame(1500, 0.3)]
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
    kind, _payload = session.queue.get_nowait()
    assert kind.startswith("audio")
