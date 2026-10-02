import struct

from voice_agent.vad import Vad, VadConfig


def pcm(rms: float, ms: int, sr: int = 16000) -> bytes:
    n = int(sr * ms / 1000)
    v = int(rms * 32768 * 0.7071)
    return struct.pack(f"<{n}h", *([v] * n))


def test_ignores_pure_silence():
    vad = Vad()
    for _ in range(50):
        assert vad.feed(pcm(0.001, 20)) is None
    assert not vad.in_speech


def test_speech_then_endpoint():
    vad = Vad(VadConfig(threshold=0.02, min_speech_ms=200, endpoint_silence_ms=400))
    assert vad.feed(pcm(0.05, 20)) == "speech_start"
    for _ in range(20):  # 400ms speech
        assert vad.feed(pcm(0.05, 20)) is None
    for _ in range(25):  # 500ms silence -> endpoint
        ev = vad.feed(pcm(0.001, 20))
        if ev == "endpoint":
            break
    else:
        raise AssertionError("no endpoint")
    data = vad.take()
    assert len(data) > 0
    assert not vad.in_speech


def test_short_speech_discarded():
    vad = Vad(VadConfig(threshold=0.02, min_speech_ms=300, endpoint_silence_ms=200))
    assert vad.feed(pcm(0.05, 20)) == "speech_start"
    for _ in range(12):  # 240ms then silence
        vad.feed(pcm(0.001, 20))
    assert vad.take() == b""


def test_max_utterance_force_endpoint():
    vad = Vad(VadConfig(threshold=0.02, max_utterance_ms=1000, endpoint_silence_ms=10000))
    ev = None
    for _ in range(60):  # 1200ms continuous speech
        ev = vad.feed(pcm(0.05, 20))
        if ev == "endpoint":
            break
    assert ev == "endpoint"
    assert len(vad.take()) > 0
