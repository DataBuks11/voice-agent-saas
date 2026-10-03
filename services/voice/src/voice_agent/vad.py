"""Turn detection.

Default is Silero VAD (the model dograh-style agents use: a neural voice
classifier plus an energy gate), with the previous energy detector kept as a
fallback so the runtime still works if the model cannot be loaded.

The detector also reports "sustained" speech: a short blip is never treated as the
caller interrupting, which is what stops the agent from talking over itself when
it picks up its own speaker output.
"""
from __future__ import annotations

import math
import os
import struct
from dataclasses import dataclass

_SILERO_AVAILABLE: bool | None = None
_SILERO_MODEL = None


def _silero():
    """Load Silero once; return None when unavailable (falls back to energy).

    Opt-in via VAD_ENGINE=silero because the package imports torch at module
    level, which we do not want to pull into the runtime image.
    """
    global _SILERO_AVAILABLE, _SILERO_MODEL
    if _SILERO_AVAILABLE is None:
        if os.getenv("VAD_ENGINE", "energy").lower() != "silero":
            _SILERO_AVAILABLE = False
            return None
        try:  # pragma: no cover - depends on the optional dependency
            from silero_vad import load_silero_vad  # type: ignore

            _SILERO_MODEL = load_silero_vad(onnx=True)
            _SILERO_AVAILABLE = True
        except Exception:
            _SILERO_AVAILABLE = False
            _SILERO_MODEL = None
    return _SILERO_MODEL if _SILERO_AVAILABLE else None


@dataclass
class VadConfig:
    threshold: float = 0.012
    # Adaptive gate: the live threshold is max(threshold, noise_floor * ratio).
    noise_ratio: float = 3.2
    # Noise floor tracking: drop fast, rise very slowly, so speech can never
    # inflate the gate (classic min-statistics VAD behaviour).
    noise_down: float = 8.0  # per second: drop quickly when the room gets quiet
    noise_up: float = 0.25  # per second: creep up so a burst of speech cannot raise it
    min_speech_ms: int = 170
    # Must sit above the longest natural pause inside a sentence, otherwise the
    # turn is cut mid-sentence and whisper transcribes a fragment.
    endpoint_silence_ms: int = 450
    max_utterance_ms: int = 45000
    # Neural threshold (Silero probability) when the model is in use.
    neural_threshold: float = 0.55
    # Energy gate on top of the neural score, as dograh does with min_volume.
    min_volume: float = 0.006
    # Speech must last this long before it counts as an interruption.
    barge_in_ms: int = 240


class Vad:
    """feed(pcm16_frame) -> 'speech_start' | 'endpoint' | None; take() after endpoint."""

    def __init__(self, config: VadConfig | None = None, sample_rate: int = 16000):
        self.cfg = config or VadConfig()
        self.sr = sample_rate
        self.in_speech = False
        self.buf = bytearray()
        self.speech_ms = 0.0
        self.silence_ms = 0.0
        self._speech_run_ms = 0.0
        self.run_peak = 0.0
        self._neural_state = None
        self.noise_rms = 0.004

    @property
    def engine(self) -> str:
        return "silero" if _silero() is not None else "energy"

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

    def _neural_speech(self, frame: bytes, rms: float) -> bool:
        """Silero probability gated by an energy floor (mirrors dograh's min_volume)."""
        model = _silero()
        if model is None:
            return False
        if rms < self.cfg.min_volume:
            # Below the volume floor: cheap, no model call.
            return False
        try:  # pragma: no cover - optional dependency
            import torch

            if self._neural_state is None:
                self._neural_state = model.reset_states()
            wav = torch.from_numpy(__import__("numpy").frombuffer(frame, dtype="int16").astype("float32") / 32768.0)
            probability = float(model(wav, self._neural_state, 16000)[0])
            return probability >= self.cfg.neural_threshold
        except Exception:
            return False

    def _live_threshold(self) -> float:
        """Energy gate that rises with room noise, so a noisy call still ends turns."""
        return max(self.cfg.threshold, self.noise_rms * self.cfg.noise_ratio)

    def feed(self, frame: bytes) -> str | None:
        if len(frame) < 2:
            return None
        if len(frame) % 2:
            frame = frame[:-1]
        rms = self._rms(frame)
        frame_ms = (len(frame) // 2) * 1000.0 / self.sr
        neural = self._neural_speech(frame, rms)
        speaking = neural or (self.engine == "energy" and rms >= self._live_threshold())
        if not self.in_speech and not speaking:
            # Only frames we are sure are not speech may move the floor.
            rate = (self.cfg.noise_down if rms < self.noise_rms else self.cfg.noise_up) * (
                frame_ms / 1000.0
            )
            self.noise_rms += rate * (rms - self.noise_rms)
        if not self.in_speech:
            if speaking:
                self.in_speech = True
                self.buf = bytearray(frame)
                self.speech_ms = frame_ms
                self.silence_ms = 0.0
                self._speech_run_ms = frame_ms
                self.run_peak = rms
                return "speech_start"
            return None
        self.buf.extend(frame)
        if speaking:
            self.silence_ms = 0.0
            self.speech_ms += frame_ms
            self._speech_run_ms += frame_ms
            if rms > self.run_peak:
                self.run_peak = rms
        else:
            self.silence_ms += frame_ms
            self._speech_run_ms = 0.0
        if self.silence_ms >= self.cfg.endpoint_silence_ms or self.speech_ms >= self.cfg.max_utterance_ms:
            self.in_speech = False
            return "endpoint"
        return None

    def sustained(self) -> bool:
        """True once the current speech run is long enough to be a real interruption."""
        return self._speech_run_ms >= self.cfg.barge_in_ms

    def peek(self) -> bytes:
        """Current utterance audio without consuming it (streaming transcripts)."""
        return bytes(self.buf) if self.in_speech or self.speech_ms > 0 else b""

    def reset(self) -> None:
        """Drop any half-heard audio (used when the agent starts speaking)."""
        self.in_speech = False
        # keep the learned noise floor across resets
        self.buf = bytearray()
        self.speech_ms = 0.0
        self.silence_ms = 0.0
        self._speech_run_ms = 0.0
        self.run_peak = 0.0
        if self._neural_state is not None:
            try:  # pragma: no cover - optional dependency
                self._neural_state = _silero().reset_states()  # type: ignore[union-attr]
            except Exception:
                self._neural_state = None

    def take(self) -> bytes:
        """Return the captured utterance (empty if too short) and reset."""
        out = bytes(self.buf) if self.speech_ms >= self.cfg.min_speech_ms else b""
        self.reset()
        return out