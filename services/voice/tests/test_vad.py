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


def _frame(ms: int, amp: float, sr: int = 16000) -> bytes:
    import math
    import struct

    n = int(sr * ms / 1000)
    return b"".join(
        struct.pack("<h", int(max(-1.0, min(1.0, amp * math.sin(i / 6.0))) * 32767))
        for i in range(n)
    )


def test_quiet_room_lowers_the_gate():
    vad = Vad(VadConfig(), 16000)
    for _ in range(60):
        vad.feed(_frame(20, 0.002))  # quiet room tone
    assert vad.noise_rms < 0.004
    assert vad._live_threshold() == VadConfig().threshold


def test_speech_does_not_inflate_the_noise_floor():
    vad = Vad(VadConfig(), 16000)
    for _ in range(60):
        vad.feed(_frame(20, 0.002))
    floor = vad.noise_rms
    loud = _frame(1000, 0.3)
    for i in range(0, len(loud), 640):
        vad.feed(loud[i : i + 640])
    # only the onset frame may touch the floor, and only slightly
    assert vad.noise_rms < floor * 3


def test_sub_gate_room_tone_raises_the_gate():
    vad = Vad(VadConfig(), 16000)
    base = VadConfig().threshold
    for _ in range(300):  # ~6 s of hiss just under the static gate
        vad.feed(_frame(20, 0.008))
    assert vad.noise_rms > 0.004
    assert vad._live_threshold() > base * 1.3


def test_noise_at_the_learned_floor_is_not_speech():
    vad = Vad(VadConfig(), 16000)
    for _ in range(300):
        vad.feed(_frame(20, 0.008))
    gate = vad._live_threshold()
    quiet = _frame(600, 0.008)
    events = [vad.feed(quiet[i : i + 640]) for i in range(0, len(quiet), 640)]
    assert "speech_start" not in events
    assert vad._live_threshold() >= gate


def test_quiet_room_keeps_the_static_gate():
    vad = Vad(VadConfig(), 16000)
    for _ in range(60):
        vad.feed(_frame(20, 0.002))
    assert vad.noise_rms < 0.004
    assert vad._live_threshold() == VadConfig().threshold


def test_sustained_gate_blocks_blips_but_allows_real_interruption():
    vad = Vad(VadConfig(barge_in_ms=320), 16000)
    vad.feed(_frame(150, 0.3))
    assert not vad.sustained()
    vad.feed(_frame(250, 0.3))
    assert vad.sustained()


def test_reset_keeps_noise_floor_but_drops_audio():
    vad = Vad(VadConfig(), 16000)
    for _ in range(60):
        vad.feed(_frame(20, 0.008))
    floor = vad.noise_rms
    vad.feed(_frame(200, 0.3))
    vad.reset()
    assert vad.peek() == b""
    assert not vad.sustained()
    assert vad.noise_rms == floor
