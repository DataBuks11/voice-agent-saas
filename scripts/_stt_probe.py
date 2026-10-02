"""Does the caller audio survive the test harness before STT sees it?

Writes both a properly resampled and a naively resampled 16 kHz wav so the
faster-whisper transcript can be compared.
"""
from __future__ import annotations

import os
import sys
import wave

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "voice", "src"))

TEXT = os.getenv("PROBE_TEXT", "How much does the growth plan cost?")
OUT = os.getenv("PROBE_DIR", os.path.join(os.environ.get("TEMP", "."), "sttprobe"))
os.makedirs(OUT, exist_ok=True)


def synth(text: str) -> tuple[bytes, int]:
    from piper import PiperVoice

    voice_path = os.getenv("PIPER_VOICE")
    v = PiperVoice.load(voice_path) if voice_path else PiperVoice.load("en_US-lessac-medium")
    buf = bytearray()
    for chunk in v.synthesize(text):
        buf += chunk.audio_int16_bytes
    return bytes(buf), 22050


def resample_proper(pcm: bytes, src_rate: int, dst_rate: int = 16000) -> bytes:
    import av

    arr = np.frombuffer(pcm, dtype=np.int16).reshape(1, -1)
    frame = av.AudioFrame.from_ndarray(arr, format="s16", layout="mono")
    frame.sample_rate = src_rate
    resampler = av.AudioResampler(format="s16", layout="mono", rate=dst_rate)
    return b"".join(f.to_ndarray().tobytes() for f in resampler.resample(frame))


def resample_naive(pcm: bytes, src_rate: int, dst_rate: int = 16000) -> bytes:
    out = bytearray()
    for i in range(0, len(pcm) - 1, 2):
        out += pcm[i : i + 2] * max(1, dst_rate // src_rate)
    return bytes(out)


def write_wav(path: str, pcm: bytes, rate: int = 16000) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


def main() -> int:
    raw, rate = synth(TEXT)
    variants = {
        "proper": resample_proper(raw, rate),
        "naive": resample_naive(raw, rate),
        "original": raw,
    }
    paths = {}
    for name, pcm in variants.items():
        p = os.path.join(OUT, f"{name}.wav")
        write_wav(p, pcm, 16000 if name != "original" else rate)
        paths[name] = p
        print(f"{name}: {len(pcm)} bytes -> {p}")

    from faster_whisper import WhisperModel

    model = WhisperModel(os.getenv("STT_MODEL", "base.en"), device="cpu", compute_type="int8")
    for name, path in paths.items():
        for vad in (True, False):
            segs, _ = model.transcribe(
                path, language="en", beam_size=3, vad_filter=vad, condition_on_previous_text=False
            )
            text = " ".join(s.text for s in segs).strip()
            print(f"{name:9s} vad={str(vad):5s} -> {text}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())