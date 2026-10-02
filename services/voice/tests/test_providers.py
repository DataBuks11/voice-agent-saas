"""Provider selection + WAV packing — no network, no model loads."""
from __future__ import annotations

import wave
import io

from voice_agent.real import stt_uses_http, tts_uses_http, wav_bytes


def test_wav_bytes_header():
    pcm = b"\x01\x02" * 160
    out = wav_bytes(pcm, 16000)
    assert out[:4] == b"RIFF" and out[8:12] == b"WAVE"
    with wave.open(io.BytesIO(out)) as w:
        assert w.getframerate() == 16000
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert w.readframes(w.getnframes()) == pcm


def test_local_default_without_key(monkeypatch):
    monkeypatch.delenv("STT_API_KEY", raising=False)
    monkeypatch.delenv("TTS_API_KEY", raising=False)
    monkeypatch.delenv("STT_PROVIDER", raising=False)
    monkeypatch.delenv("TTS_PROVIDER", raising=False)
    assert not stt_uses_http()
    assert not tts_uses_http()


def test_http_when_key_set(monkeypatch):
    monkeypatch.setenv("STT_API_KEY", "sk-test")
    monkeypatch.setenv("TTS_API_KEY", "sk-test")
    monkeypatch.delenv("STT_PROVIDER", raising=False)
    monkeypatch.delenv("TTS_PROVIDER", raising=False)
    assert stt_uses_http()
    assert tts_uses_http()


def test_provider_can_force_local(monkeypatch):
    monkeypatch.setenv("STT_API_KEY", "sk-test")
    monkeypatch.setenv("TTS_API_KEY", "sk-test")
    monkeypatch.setenv("STT_PROVIDER", "local")
    monkeypatch.setenv("TTS_PROVIDER", "piper")
    assert not stt_uses_http()
    assert not tts_uses_http()


def test_provider_named_without_key_stays_local(monkeypatch):
    monkeypatch.delenv("STT_API_KEY", raising=False)
    monkeypatch.setenv("STT_PROVIDER", "whisper-compatible")
    assert not stt_uses_http()
