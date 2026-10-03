"""STT configuration and audio-contract tests (no model download required)."""
from __future__ import annotations

import math
import struct

import pytest

from voice_agent.contract import (
    MIC,
    STT,
    AudioContractError,
    duration_seconds,
    to_mono16k,
    validate_mic_frame,
    validate_output_chunk,
)


def tone(ms: int, freq: float = 220.0, rate: int = 16000, amp: float = 0.3) -> bytes:
    n = int(rate * ms / 1000)
    return b"".join(
        struct.pack("<h", int(max(-1.0, min(1.0, amp * math.sin(2 * math.pi * freq * i / rate))) * 32767))
        for i in range(n)
    )


# --------------------------------------------------------------------------- #
# Phase 9: the audio contract
# --------------------------------------------------------------------------- #
def test_mic_contract_is_16k_mono_s16_20ms():
    assert MIC.sample_rate == 16000
    assert MIC.channels == 1
    assert MIC.sample_width == 2
    assert MIC.frame_ms == 20
    assert MIC.frame_bytes == 640
    assert MIC.bytes_per_second == 32000
    assert STT == MIC


def test_stt_input_rate_matches_the_contract():
    assert STT.sample_rate == MIC.sample_rate


def test_odd_byte_count_is_rejected():
    with pytest.raises(AudioContractError):
        validate_mic_frame(b"\x00\x01\x02")


def test_output_chunk_validation():
    pcm, rate = validate_output_chunk(tone(20, rate=24000), 24000, 24000)
    assert rate == 24000 and len(pcm) == 960
    with pytest.raises(AudioContractError):
        validate_output_chunk(b"", 24000)
    with pytest.raises(AudioContractError):
        validate_output_chunk(b"\x00" * 3, 24000)
    with pytest.raises(AudioContractError):
        validate_output_chunk(tone(20), 24000, 16000)  # announced rate mismatch


def test_duration_matches_byte_length():
    assert duration_seconds(tone(1000)) == pytest.approx(1.0, abs=0.01)


def test_resample_only_at_the_boundary():
    # 22.05 kHz (piper) -> 16 kHz (STT), and no repeated conversion afterwards
    converted = to_mono16k(tone(1000, rate=22050), 22050)
    assert duration_seconds(converted) == pytest.approx(1.0, abs=0.02)
    assert to_mono16k(converted, 16000) is converted  # already at the target


def test_resample_keeps_the_signal():
    converted = to_mono16k(tone(500, rate=44100), 44100)
    assert max(abs(int.from_bytes(converted[i : i + 2], "little", signed=True)) for i in range(0, 200, 2)) > 1000


# --------------------------------------------------------------------------- #
# Phase 6: short utterances must survive the pipeline
# --------------------------------------------------------------------------- #
def test_short_utterances_are_long_enough_to_be_a_turn():
    """'yes' / 'no' / '9 AM' are short; the VAD must not treat them as noise."""
    from voice_agent.vad import Vad, VadConfig

    vad = Vad(VadConfig(), 16000)
    for word_ms in (260, 320, 400):
        vad.reset()
        pcm = tone(word_ms, amp=0.25)
        for i in range(0, len(pcm), 640):
            vad.feed(pcm[i : i + 640])
        assert vad.speech_ms >= 170, f"{word_ms}ms utterance was treated as noise"
        assert len(vad.take()) > 0


def test_vad_does_not_split_a_sentence_on_a_natural_pause():
    from voice_agent.vad import Vad, VadConfig

    vad = Vad(VadConfig(), 16000)
    events = []
    for piece in (tone(700), tone(300), tone(700)):
        for i in range(0, len(piece), 640):
            ev = vad.feed(piece[i : i + 640])
            if ev:
                events.append(ev)
    assert events == ["speech_start"]