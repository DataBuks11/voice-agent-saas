import asyncio
from voice_agent.pipeline import VoicePipeline, VoiceConfig
from voice_agent.providers import StubSTT, StubLLM, StubTTS


def test_barge_in_flag():
    p = VoicePipeline(StubSTT(), StubLLM(), StubTTS(), VoiceConfig(allow_barge_in=True))
    p.handle_barge_in()
    assert p.interrupted is True


def test_empty_audio_returns_empty():
    p = VoicePipeline(StubSTT(), StubLLM(), StubTTS())
    assert asyncio.run(p.handle_audio(b"\x00" * 320)) == ""
