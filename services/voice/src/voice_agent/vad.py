"""Energy-based voice activity detection with endpointing. Pure stdlib for easy testing."""
from __future__ import annotations

import math
import struct
from dataclasses import dataclass


@dataclass
class VadConfig:
    threshold: float = 0.012
    min_speech_ms: int = 170
    endpoint_silence_ms: int = 250
    max_utterance_ms: int = 45000


class Vad:
    """feed(pcm16_frame) -> 'speech_start' | 'endpoint' | None; take() after endpoint."""

    def __init__(self, config: VadConfig | None = None, sample_rate: int = 16000):
        self.cfg = config or VadConfig()
        self.sr = sample_rate
        self.in_speech = False
        self.buf = bytearray()
        self.speech_ms = 0.0
        self.silence_ms = 0.0

    @staticmethod
    def _rms(frame: bytes) -> float:
        n = len(frame) // 2
        if n == 0:
            return 0.0
        samples = struct.unpack(f"<{n}h", frame[: n * 2])
        acc = 0
        for s in samples:
            acc += s * s
        return math.sqrt(acc / n) / 32768.0

    def feed(self, frame: bytes) -> str | None:
        if len(frame) < 2:
            return None
        if len(frame) % 2:
            frame = frame[:-1]
        rms = self._rms(frame)
        frame_ms = (len(frame) // 2) * 1000.0 / self.sr
        if not self.in_speech:
            if rms >= self.cfg.threshold:
                self.in_speech = True
                self.buf = bytearray(frame)
                self.speech_ms = frame_ms
                self.silence_ms = 0.0
                return "speech_start"
            return None
        self.buf.extend(frame)
        if rms >= self.cfg.threshold:
            self.silence_ms = 0.0
            self.speech_ms += frame_ms
        else:
            self.silence_ms += frame_ms
        if self.silence_ms >= self.cfg.endpoint_silence_ms or self.speech_ms >= self.cfg.max_utterance_ms:
            self.in_speech = False
            return "endpoint"
        return None

    def peek(self) -> bytes:
        """Current utterance audio without consuming it (streaming transcripts)."""
        return bytes(self.buf) if self.in_speech or self.speech_ms > 0 else b""

    def take(self) -> bytes:
        """Return the captured utterance (empty if too short) and reset."""
        out = bytes(self.buf) if self.speech_ms >= self.cfg.min_speech_ms else b""
        self.buf = bytearray()
        self.speech_ms = 0.0
        self.silence_ms = 0.0
        return out
