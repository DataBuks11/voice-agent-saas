"""Deterministic tests for the staged orchestrator.

Each test maps to a reported production failure.
"""
from __future__ import annotations

import asyncio

import pytest

from voice_agent.orchestrator import (
    ConversationEngine,
    EventType,
    IllegalTransition,
    TranscriptNormalizer,
    TurnState,
    VoiceOrchestrator,
    split_for_tts,
)


def make_orchestrator(answer: str = "Sure, that is booked.", delay: float = 0.0, history=None):
    calls: list[str] = []

    async def complete(user: str, ctx: str) -> str:
        calls.append(user)
        if delay:
            await asyncio.sleep(delay)
        return answer

    engine = ConversationEngine(complete, history or (lambda: ""))
    audio: list[tuple[int, int]] = []

    async def on_audio(pcm: bytes, rate: int, turn) -> None:
        audio.append((len(pcm), rate))

    orch = VoiceOrchestrator("s1", engine=engine, on_audio=on_audio)
    return orch, calls, audio


def kinds(orch) -> list[str]:
    return [e.type.value for e in orch.bus.trace]


# --------------------------------------------------------------------------- #
# Phase 3: state machine
# --------------------------------------------------------------------------- #
def test_illegal_transitions_are_refused():
    orch, _calls, _audio = make_orchestrator()
    assert orch.state is TurnState.LISTENING
    # LISTENING -> THINKING (no user turn) must be impossible
    assert orch.transitions(TurnState.LISTENING, TurnState.THINKING, "no user turn") is False
    assert orch.state is TurnState.LISTENING
    # SPEAKING -> THINKING must be impossible
    assert orch.transitions(TurnState.SPEAKING, TurnState.THINKING, "no user turn") is False
    assert EventType.VOICE_ERROR.value in kinds(orch)


def test_normal_transition_sequence_is_allowed():
    orch, _calls, _audio = make_orchestrator()
    orch.begin_speech()
    orch.end_speech()
    assert orch._require(TurnState.THINKING, "accepted")
    assert orch._require(TurnState.SPEAKING, "audio")
    assert orch._require(TurnState.LISTENING, "done")
    assert not [t for t in orch.state_history if t[2] is TurnState.THINKING and t[1] is TurnState.SPEAKING]


# --------------------------------------------------------------------------- #
# TEST 6 / Phase 3: silence, noise, partials must never reach the LLM
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "text",
    ["", "   ", "\u200b", "uh", "hmm", "um", "huh", "...", "uh huh", "so", "ha", "haha"],
)
def test_silence_and_noise_never_reach_the_llm(text):
    orch, calls, _audio = make_orchestrator()
    turn = orch.begin_speech()
    orch.end_speech()
    accepted, reason = orch.on_final(text)
    assert accepted is False
    assert reason
    assert calls == []
    assert orch.state is TurnState.LISTENING


def test_partial_transcript_never_reaches_the_llm():
    orch, calls, _audio = make_orchestrator()
    orch.begin_speech()
    orch.on_partial("how much does the", revision=1)
    orch.on_partial("how much does the growth", revision=2)
    orch.end_speech()
    assert calls == []
    # only the final transcript may open the turn
    assert orch.on_final("How much does the growth plan cost?") == (True, None)


# --------------------------------------------------------------------------- #
# TEST 8/9: partial + duplicate finals collapse to one accepted turn
# --------------------------------------------------------------------------- #
def test_partials_do_not_accumulate_in_the_conversation():
    norm = TranscriptNormalizer()
    assert norm.normalize("  how   much does the growth plan cost?  ") == "how much does the growth plan cost?"
    # whisper stutter on chunk boundaries
    assert norm.normalize("I I want to book") == "I want to book"


def test_duplicate_final_is_rejected():
    orch, calls, _audio = make_orchestrator()
    t1 = orch.begin_speech()
    orch.end_speech()
    assert orch.on_final("I want an appointment")[0] is True
    t2 = orch.begin_speech()
    orch.end_speech()
    accepted, reason = orch.on_final("I want an appointment")
    assert accepted is False
    assert reason and reason.startswith("duplicate_of")
    assert EventType.USER_TURN_REJECTED.value in kinds(orch)


def test_stale_revision_is_rejected():
    orch, calls, _audio = make_orchestrator()
    orch.begin_speech()
    orch.on_partial("book me", revision=5)
    orch.end_speech()
    accepted, reason = orch.on_final("book me", revision=2)
    assert accepted is False
    assert reason == "stale_revision"


# --------------------------------------------------------------------------- #
# TEST 10 / Phase 12: stale LLM result is discarded
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_old_llm_answer_is_discarded_after_a_new_turn():
    orch, calls, _audio = make_orchestrator(answer="STALE ANSWER", delay=0.05)
    first = orch.begin_speech()
    orch.end_speech()
    orch.on_final("what are your hours")
    task = asyncio.create_task(orch.run_conversation(first))
    await asyncio.sleep(0.01)
    # caller interrupts with a new utterance
    orch.interrupt("caller_speech")
    second = orch.begin_speech()
    orch.end_speech()
    orch.on_final("actually book me for tomorrow")
    answer = await task
    assert answer == ""
    assert orch.stats["stale_discarded"] >= 1
    assert second.turn_id != first.turn_id


@pytest.mark.asyncio
async def test_interrupted_turn_never_speaks():
    orch, calls, audio = make_orchestrator()
    turn = orch.begin_speech()
    orch.end_speech()
    orch.on_final("tell me about the enterprise plan")
    orch.interrupt("caller_speech")
    answer = await orch.run_conversation(turn)
    assert answer == ""
    assert audio == []
    assert orch.audio_playback_active is False


# --------------------------------------------------------------------------- #
# TEST 7 / Phase 10: interruption flushes audio and keeps the new turn
# --------------------------------------------------------------------------- #
def test_interruption_flushes_and_increments_turn():
    orch, _calls, _audio = make_orchestrator()
    a = orch.begin_speech()
    orch.end_speech()
    orch.on_final("hello there")
    orch.speaking_started(a)
    assert orch.audio_playback_active is True
    orch.interrupt("caller_speech")
    assert orch.audio_playback_active is False
    b = orch.begin_speech()
    assert b.turn_id != a.turn_id
    assert b.index == a.index + 1
    assert EventType.INTERRUPTION_STARTED.value in kinds(orch)
    assert EventType.AUDIO_QUEUE_FLUSH.value in kinds(orch)
    assert EventType.INTERRUPTION_COMPLETED.value in kinds(orch)


# --------------------------------------------------------------------------- #
# Phase 4: startup
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_session_is_listening_before_any_audio():
    orch, _calls, _audio = make_orchestrator()
    assert orch.state is TurnState.LISTENING
    assert EventType.VOICE_SESSION_STARTED.value not in kinds(orch)  # emitted by transport
    assert orch.metrics()["state"] == "LISTENING"


# --------------------------------------------------------------------------- #
# Phase 8: phrase boundaries for TTS
# --------------------------------------------------------------------------- #
def test_tts_never_gets_half_sentences():
    parts = split_for_tts("Your appointment is confirmed. Your booking is for Saturday at 9 AM.")
    assert parts == ["Your appointment is confirmed.", "Your booking is for Saturday at 9 AM."]
    long_one = "word " * 100
    chunks = split_for_tts(long_one)
    assert all(len(p) <= 230 for p in chunks)
    # nothing is lost or duplicated when a long sentence has to be wrapped
    assert sum(len(p.split()) for p in chunks) == len(long_one.split())


def test_split_handles_empty_and_awkward_text():
    assert split_for_tts("") == []
    assert split_for_tts("   ") == []
    assert split_for_tts("No punctuation at all") == ["No punctuation at all"]


# --------------------------------------------------------------------------- #
# Phase 16: observability
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_trace_records_every_stage_with_sequence_and_turn():
    orch, _calls, _audio = make_orchestrator()
    turn = orch.begin_speech()
    orch.on_partial("hello", revision=1)
    orch.end_speech()
    orch.on_final("what are your opening hours")
    await orch.run_conversation(turn)
    orch.speaking_started(turn)
    orch.speaking_finished(turn)
    events = list(orch.bus.trace)
    seqs = [e.sequence for e in events]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    for e in events:
        d = e.to_dict()
        assert d["sessionId"] == "s1"
        assert "timestamp" in d and "sequence" in d and "type" in d
        assert d["turnId"] == turn.turn_id
    names = {e.type.value for e in events}
    for required in (
        "USER_SPEECH_STARTED",
        "STT_PARTIAL",
        "USER_SPEECH_STOPPED",
        "STT_FINAL",
        "USER_TURN_ACCEPTED",
        "CONTEXT_STARTED",
        "CONTEXT_READY",
        "LLM_STARTED",
        "LLM_COMPLETED",
        "ASSISTANT_TURN_STARTED",
        "ASSISTANT_TURN_COMPLETED",
    ):
        assert required in names, required


def test_no_event_is_emitted_for_a_cancelled_turn():
    orch, _calls, _audio = make_orchestrator()
    turn = orch.begin_speech()
    orch.interrupt("caller_speech")
    orch.on_partial("ignored", revision=1)
    assert turn.turn_id not in {e.turn_id for e in orch.bus.trace if e.type is EventType.STT_PARTIAL}


# --------------------------------------------------------------------------- #
# Phase 17: error recovery
# --------------------------------------------------------------------------- #
def test_error_returns_to_listening():
    orch, _calls, _audio = make_orchestrator()
    orch.error("stt_failed")
    assert orch.state is TurnState.LISTENING
    assert EventType.VOICE_ERROR.value in kinds(orch)


@pytest.mark.asyncio
async def test_llm_failure_produces_a_controlled_fallback():
    async def boom(user: str, ctx: str) -> str:
        raise RuntimeError("llm down")

    engine = ConversationEngine(boom, lambda: "")
    orch = VoiceOrchestrator("s1", engine=engine, on_audio=lambda *a: asyncio.sleep(0))
    turn = orch.begin_speech()
    orch.end_speech()
    orch.on_final("hello")
    # the caller (server) is responsible for the fallback text; the turn must not hang
    with pytest.raises(RuntimeError):
        await orch.run_conversation(turn)


def test_session_end_cancels_in_flight_turn():
    orch, _calls, _audio = make_orchestrator()
    turn = orch.begin_speech()
    orch.end()
    assert turn.cancelled.is_set()
    assert orch.state is TurnState.ENDED

@pytest.mark.asyncio
async def test_late_playback_completion_does_not_block_the_next_turn():
    """Turn N's audio window can finish after turn N+1 was accepted."""
    orch, calls, _audio = make_orchestrator()
    first = orch.begin_speech()
    orch.end_speech()
    orch.on_final("what are your hours")
    orch.speaking_started(first)
    # a new utterance interrupts while the first reply is still playing
    second = orch.begin_speech()
    orch.end_speech()
    assert orch.on_final("book me for tomorrow")[0] is True
    # turn 1's playback finishes late and resets the shared state
    orch.state = TurnState.LISTENING
    orch.reclaim_for(second)
    answer = await orch.run_conversation(second)
    assert answer == "Sure, that is booked."
    assert calls == ["book me for tomorrow"]


def test_reclaim_never_reinstates_a_cancelled_turn():
    orch, _calls, _audio = make_orchestrator()
    turn = orch.begin_speech()
    orch.interrupt("caller_speech")
    orch.state = TurnState.LISTENING
    orch.reclaim_for(turn)
    assert orch.state is TurnState.LISTENING


# --------------------------------------------------------------------------- #
# Noise must not delete an answer that is already on its way
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_noise_does_not_cancel_a_pending_answer():
    orch, calls, _audio = make_orchestrator()
    first = orch.begin_speech()
    orch.end_speech()
    orch.on_final("what are your opening hours")
    task = asyncio.create_task(orch.run_conversation(first))
    await asyncio.sleep(0)

    # a noise burst opens a turn while the answer is still being generated
    noise = orch.ensure_speech_turn()
    orch.end_speech()
    accepted, reason = orch.on_final("uh huh")
    assert accepted is False and reason
    # the real answer survives and still belongs to the session
    assert await task == "Sure, that is booked."
    assert orch.turns.current is first
    assert first.cancelled.is_set() is False
    assert noise is not first


@pytest.mark.asyncio
async def test_confirmed_interruption_cancels_the_pending_answer():
    orch, calls, _audio = make_orchestrator(answer="STALE", delay=0.05)
    first = orch.begin_speech()
    orch.end_speech()
    orch.on_final("what are your opening hours")
    task = asyncio.create_task(orch.run_conversation(first))
    await asyncio.sleep(0.01)
    second = orch.ensure_speech_turn()
    orch.end_speech()
    assert orch.on_final("actually book me for tomorrow")[0] is True
    assert await task == ""
    assert first.cancelled.is_set() is True
    assert orch.stats["interruptions"] >= 1


@pytest.mark.asyncio
async def test_noise_between_llm_and_audio_does_not_delete_the_answer():
    """The exact production failure: a noise turn opened while the LLM ran."""
    orch, calls, _audio = make_orchestrator(answer="Growth is $199", delay=0.03)
    first = orch.begin_speech()
    orch.end_speech()
    orch.on_final("how much does the growth plan cost")
    task = asyncio.create_task(orch.run_conversation(first))
    await asyncio.sleep(0.005)
    # noise opens a turn mid-flight
    noise = orch.ensure_speech_turn()
    orch.end_speech()
    assert await task == "Growth is $199"
    # the noise is then judged and rejected; the answer was already delivered
    accepted, reason = orch.on_final("uh huh")
    assert accepted is False
    assert first.cancelled.is_set() is False
    assert orch.turns.is_live(first) is True
    assert orch.turns.is_live(noise) is True


@pytest.mark.asyncio
async def test_queued_noise_never_silences_a_live_answer():
    """Regression: enqueue() used to set a global flag that emptied _speak."""
    orch, calls, audio = make_orchestrator(answer="Growth is $199")
    turn = orch.begin_speech()
    orch.end_speech()
    orch.on_final("how much does the growth plan cost")
    assert await orch.run_conversation(turn) == "Growth is $199"
    # a noise turn arrives while the answer is being spoken
    noise = orch.ensure_speech_turn()
    orch.note_queued_utterance(noise)
    assert turn.cancelled.is_set() is False
    orch.speaking_started(turn)
    orch.speaking_finished(turn)
    assert orch.state is TurnState.LISTENING


@pytest.mark.asyncio
async def test_queued_utterance_during_playback_is_an_interruption():
    orch, _calls, _audio = make_orchestrator()
    turn = orch.begin_speech()
    orch.end_speech()
    orch.on_final("tell me about the enterprise plan")
    orch.speaking_started(turn)  # audio is playing
    other = orch.ensure_speech_turn()
    orch.note_queued_utterance(other)
    assert orch.stats["interruptions"] >= 1


@pytest.mark.asyncio
async def test_noise_turn_steal_does_not_block_the_accepted_turn():
    """A noise turn between enqueue and the worker must not strand the answer."""
    orch, calls, _audio = make_orchestrator(answer="Enterprise starts at $1200", delay=0.02)
    real = orch.begin_speech()
    orch.end_speech()
    assert orch.on_final("what about the enterprise plan")[0] is True
    await asyncio.sleep(0)  # the fake mic opens a turn before the worker runs
    noise = orch.ensure_speech_turn()
    orch.end_speech()
    orch.reclaim_for(real)
    assert await orch.run_conversation(real) == "Enterprise starts at $1200"


def test_playback_start_and_finish_are_recorded_even_after_a_state_change():
    orch, _calls, _audio = make_orchestrator()
    turn = orch.begin_speech()
    orch.end_speech()
    orch.on_final("hello there")
    orch.state = TurnState.TRANSCRIBING  # a newer turn moved the state on
    orch.speaking_started(turn)
    assert orch.audio_playback_active is True
    assert orch.state is TurnState.SPEAKING
    orch.speaking_finished(turn)
    assert orch.audio_playback_active is False
    assert orch.state is TurnState.LISTENING


@pytest.mark.asyncio
async def test_accepted_turn_survives_a_state_race_with_noise():
    """Room noise keeps moving the shared state; real turns must still answer."""
    orch, calls, _audio = make_orchestrator(answer="Enterprise starts at $1200")
    real = orch.begin_speech()
    orch.end_speech()
    assert orch.on_final("what about the enterprise plan")[0] is True
    # a noise turn takes the state right before the worker starts
    orch.state = TurnState.USER_SPEAKING
    assert await orch.run_conversation(real) == "Enterprise starts at $1200"
    assert calls == ["what about the enterprise plan"]


@pytest.mark.asyncio
async def test_reject_cooldown_stops_a_noise_source_from_spamming_turns():
    import time as _t

    orch, calls, _audio = make_orchestrator()
    first = orch.begin_speech()
    orch.end_speech()
    assert orch.on_final("uh huh")[0] is False
    assert orch.ensure_speech_turn() is None  # inside the cooldown window
    orch.reject_cooldown_until = _t.time() - 1
    noise = orch.ensure_speech_turn()
    assert noise is not None and noise is not first


# --------------------------------------------------------------------------- #
# Phase 6/18: decoder artefacts must never reach the model
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "text",
    [
        "Call with a phone call with a phone call with a phone call",
        "thank you thank you thank you thank you thank you thank you",
        "no no no no no no no no no",
        "the the the the the the the the the the",
    ],
)
def test_decoder_loops_are_rejected(text):
    """The raw decode is checked before stutter collapsing can hide the loop."""
    norm = TranscriptNormalizer()
    assert norm.looks_like_loop(text) is True
    ok, reason = norm.is_meaningful(text)
    assert ok is False
    assert reason == "decoder_loop"


@pytest.mark.parametrize(
    "text",
    [
        "I want to book an appointment for tomorrow morning",
        "My name is Sudhanshu and I need to see the dentist",
        "that time doesn't work, can you offer another slot",
        "no problem",
        "yes",
    ],
)
def test_real_speech_is_not_mistaken_for_a_loop(text):
    norm = TranscriptNormalizer()
    ok, _reason = norm.is_meaningful(norm.normalize(text))
    assert ok is True, text


def test_low_confidence_decode_is_rejected():
    orch, calls, _audio = make_orchestrator()
    orch.begin_speech()
    orch.end_speech()
    accepted, reason = orch.on_final("word word word", confidence=0.11)
    assert accepted is False
    assert reason.startswith("low_confidence")
    assert calls == []


def test_high_confidence_real_speech_is_accepted():
    orch, calls, _audio = make_orchestrator()
    orch.begin_speech()
    orch.end_speech()
    assert orch.on_final("book me for tomorrow at nine", confidence=0.82)[0] is True


def test_long_utterance_is_capped():
    from voice_agent.vad import Vad, VadConfig

    assert VadConfig().max_utterance_ms <= 25000
    vad = Vad(VadConfig(), 16000)
    events = []
    loud = b"\x00\x30" * 640  # 20 ms at a constant loud level
    for _ in range(1100):  # 22 s of continuous tone
        ev = vad.feed(loud)
        if ev:
            events.append(ev)
    assert "endpoint" in events, "a 22 s blob must not be treated as one utterance"


@pytest.mark.asyncio
async def test_a_turn_keeps_its_own_words_when_a_noise_turn_opens_first():
    """Regression: validation used turns.current and moved words between turns."""
    orch, calls, _audio = make_orchestrator(answer="Enterprise starts at $1200")
    mine = orch.begin_speech()
    orch.end_speech()
    # a noise turn becomes current while our utterance waits in the queue
    noise = orch.begin_speech()
    orch.end_speech()
    accepted, reason = orch.on_final("what about the enterprise plan", turn=mine)
    assert accepted is True, reason
    # the words landed on the turn that owned them, and it owns the session again
    assert mine.transcript == "what about the enterprise plan"
    assert mine.accepted is True
    assert orch.turns.current is mine
    assert orch.on_final("uh huh", turn=noise)[0] is False
    assert await orch.run_conversation(mine) == "Enterprise starts at $1200"
    assert calls == ["what about the enterprise plan"]


def test_cancelled_turn_cannot_be_validated():
    orch, calls, _audio = make_orchestrator()
    turn = orch.begin_speech()
    orch.interrupt("caller_speech")
    accepted, reason = orch.on_final("hello", turn=turn)
    assert accepted is False
    assert reason == "cancelled_final"
    assert calls == []


# --------------------------------------------------------------------------- #
# Phase 8: stream the model, speak whole phrases only
# --------------------------------------------------------------------------- #
def test_phrase_buffer_only_releases_complete_phrases():
    from voice_agent.orchestrator import PhraseBuffer

    buf = PhraseBuffer()
    assert buf.push("Your appointment is confirmed") == []
    assert buf.push(". Your booking is for Saturday at 9 AM") == [
        "Your appointment is confirmed."
    ]
    assert buf.flush() == ["Your booking is for Saturday at 9 AM"]


def test_phrase_buffer_never_splits_a_word():
    from voice_agent.orchestrator import PhraseBuffer

    buf = PhraseBuffer(max_chars=40)
    out = []
    for ch in "one two three four five six seven eight nine ten eleven twelve":
        out += buf.push(ch)
    out += buf.flush()
    joined = " ".join(out)
    assert joined.split() == "one two three four five six seven eight nine ten eleven twelve".split()


@pytest.mark.asyncio
async def test_first_phrase_is_spoken_before_the_model_finishes():
    """Regression: audio used to start only after the whole answer existed."""
    from voice_agent.orchestrator import ConversationEngine

    spoken: list[tuple[str, float]] = []

    async def complete(user: str, ctx: str) -> str:  # pragma: no cover - unused
        return "unused"

    async def stream(user: str, ctx: str):
        for piece in ["Your appointment is confirmed. ", "Your booking is ", "Saturday at 9 AM."]:
            yield piece
            await asyncio.sleep(0.01)

    async def speak(phrase: str) -> None:
        spoken.append((phrase, asyncio.get_event_loop().time()))

    engine = ConversationEngine(complete, lambda: "", stream=stream)
    orch = VoiceOrchestrator("s1", engine=engine, on_audio=lambda *a: asyncio.sleep(0))
    turn = orch.begin_speech()
    orch.end_speech()
    assert orch.on_final("book me for saturday")[0] is True
    answer = await orch.speak_stream(turn, speak)
    assert answer == "Your appointment is confirmed. Your booking is Saturday at 9 AM."
    phrases = [p for p, _ in spoken]
    assert phrases == ["Your appointment is confirmed.", "Your booking is Saturday at 9 AM."]
    # the first audio started while the model was still producing text
    assert "llm_first_token" in turn.metrics
    assert "tts_first_audio" in turn.metrics


@pytest.mark.asyncio
async def test_interrupting_a_stream_stops_the_audio_immediately():
    from voice_agent.orchestrator import ConversationEngine

    spoken: list[str] = []

    async def complete(user: str, ctx: str) -> str:  # pragma: no cover
        return "unused"

    async def stream(user: str, ctx: str):
        yield "First sentence is here. "
        await asyncio.sleep(0.05)
        yield "Second sentence should never be spoken."

    async def speak(phrase: str) -> None:
        spoken.append(phrase)
        if phrase.startswith("First"):
            orch.interrupt("caller_speech")

    engine = ConversationEngine(complete, lambda: "", stream=stream)
    orch = VoiceOrchestrator("s1", engine=engine, on_audio=lambda *a: asyncio.sleep(0))
    turn = orch.begin_speech()
    orch.end_speech()
    assert orch.on_final("book me")[0] is True
    await orch.speak_stream(turn, speak)
    assert spoken == ["First sentence is here."]
    assert orch.stats["cancelled_tasks"] >= 1


@pytest.mark.asyncio
async def test_stream_failure_gives_a_controlled_fallback():
    from voice_agent.orchestrator import ConversationEngine

    spoken: list[str] = []

    async def complete(user: str, ctx: str) -> str:  # pragma: no cover
        return "unused"

    async def stream(user: str, ctx: str):
        raise RuntimeError("model exploded")
        yield ""  # pragma: no cover

    async def speak(phrase: str) -> None:
        spoken.append(phrase)

    engine = ConversationEngine(complete, lambda: "", stream=stream)
    orch = VoiceOrchestrator("s1", engine=engine, on_audio=lambda *a: asyncio.sleep(0))
    turn = orch.begin_speech()
    orch.end_speech()
    orch.on_final("hello there")
    answer = await orch.speak_stream(turn, speak)
    assert "temporary problem" in answer
    assert spoken and "temporary problem" in spoken[0]


def test_typed_input_is_never_swallowed_by_the_noise_cooldown():
    orch, _calls, _audio = make_orchestrator()
    noise = orch.begin_speech()
    orch.end_speech()
    assert orch.on_final("uh huh", turn=noise)[0] is False
    assert orch.ensure_speech_turn() is None  # audio path respects the cooldown
    typed = orch.ensure_speech_turn(force=True)
    assert typed is not None and typed is not noise


def test_asking_the_same_question_twice_is_allowed(monkeypatch):
    """Regression: the duplicate guard refused a legitimate repeat.

    A caller asking the same thing again is normal; only a duplicate STT event
    inside the duplicate window is suppressed.
    """
    import voice_agent.orchestrator as orch_mod

    monkeypatch.setattr(orch_mod, "DUPLICATE_WINDOW_S", 0.0)
    orch, calls, _audio = make_orchestrator()
    first = orch.begin_speech()
    orch.end_speech()
    assert orch.on_final("what are your hours")[0] is True
    second = orch.begin_speech()
    orch.end_speech()
    accepted, reason = orch.on_final("what are your hours")
    assert accepted is True, reason
    assert second.turn_id != first.turn_id


def test_the_same_event_firing_twice_is_still_rejected():
    """A duplicate final within the window is one utterance, not two."""
    import time as _t

    orch, calls, _audio = make_orchestrator()
    orch.begin_speech()
    orch.end_speech()
    assert orch.on_final("book me for tomorrow")[0] is True
    _t.sleep(0.05)
    orch.begin_speech()
    orch.end_speech()
    accepted, reason = orch.on_final("book me for tomorrow")
    assert accepted is False
    assert reason and reason.startswith("duplicate_of")
