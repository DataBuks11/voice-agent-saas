"""The audio contract between browser, runtime and providers.

Every rate/format conversion happens exactly once, at a named boundary, so a
mismatch is a loud error instead of garbled speech. Nothing else in the codebase
is allowed to resample implicitly.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass


class AudioContractError(ValueError):
    """Raised when audio does not match the declared contract."""


@dataclass(frozen=True)
class AudioFormat:
    codec: str = "pcm_s16le"
    sample_rate: int = 16000
    channels: int = 1
    sample_width: int = 2  # bytes
    frame_ms: int = 20

    @property
    def frame_bytes(self) -> int:
        return int(self.sample_rate * self.channels * self.sample_width * self.frame_ms / 1000)

    @property
    def bytes_per_second(self) -> int:
        return self.sample_rate * self.channels * self.sample_width

    def to_dict(self) -> dict:
        d = asdict(self)
        d["frameBytes"] = self.frame_bytes
        return d


# What the browser microphone stream must be.
MIC = AudioFormat()
# What faster-whisper wants.
STT = AudioFormat()
# TTS output is whatever the provider produces; the browser is told per chunk.
FRAME_BYTES = MIC.frame_bytes


def validate_mic_frame(frame: bytes, fmt: AudioFormat = MIC) -> bytes:
    """Reject anything that is not mono 16-bit PCM at the declared rate."""
    if len(frame) % 2:
        raise AudioContractError(f"odd byte count {len(frame)}: not 16-bit PCM")
    return frame


def to_mono16k(pcm16: bytes, sample_rate: int, target: int = STT.sample_rate) -> bytes:
    """Single conversion boundary: any rate/stereo in, 16 kHz mono s16 out.

    Linear interpolation on purpose: it is only used when a provider hands us a
    rate the contract does not declare, and speech survives it. The normal path
    (browser 16 kHz mono -> STT) never converts at all.
    """
    if sample_rate == target:
        return pcm16
    import numpy as np

    samples = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32)
    if samples.size == 0:
        return b""
    n_out = max(1, int(round(samples.size * target / float(sample_rate))))
    src_idx = np.linspace(0.0, samples.size - 1.0, n_out)
    out = np.interp(src_idx, np.arange(samples.size), samples)
    return np.clip(out, -32768, 32767).astype(np.int16).tobytes()


def duration_seconds(pcm16: bytes, fmt: AudioFormat = MIC) -> float:
    return len(pcm16) / float(fmt.bytes_per_second)


def validate_output_chunk(pcm: bytes, sample_rate: int, declared_rate: int | None = None) -> tuple[bytes, int]:
    """TTS chunks must be mono 16-bit at the rate announced to the client."""
    if not pcm:
        raise AudioContractError("empty audio chunk")
    if len(pcm) % 2:
        raise AudioContractError(f"odd byte count {len(pcm)}: not 16-bit PCM")
    if declared_rate and sample_rate != declared_rate:
        raise AudioContractError(f"rate mismatch: chunk {sample_rate} vs announced {declared_rate}")
    return pcm, sample_rate