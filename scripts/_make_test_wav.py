"""Generate a 16 kHz mono WAV of real speech for the browser voice test.

Chrome's fake capture device emits a pure tone, which the runtime correctly
treats as noise. Feeding it a real sentence exercises the whole chain:
speech -> VAD -> STT -> transcript -> answer -> audio.

    python scripts/_make_test_wav.py "How much does the growth plan cost?"
"""
from __future__ import annotations

import os
import sys
import wave

DEFAULT_TEXT = "How much does the growth plan cost?"
OUT = os.getenv("TEST_MIC_WAV", os.path.join(os.environ.get("TEMP", "."), "voice_test_mic.wav"))


def synth_16k(text: str) -> bytes:
    import io

    import numpy as np
    from piper import PiperVoice

    voice_path = os.getenv("PIPER_VOICE") or os.path.join(
        os.environ.get("LOCALAPPDATA", ""), "piper", "en_US-lessac-medium.onnx"
    )
    if not os.path.exists(voice_path):
        raise SystemExit(f"piper voice not found: {voice_path}")
    voice = PiperVoice.load(voice_path)
    buf = bytearray()
    for chunk in voice.synthesize(text):
        buf += chunk.audio_int16_bytes
    samples = np.frombuffer(bytes(buf), dtype=np.int16).astype(np.float32)
    src = 22050
    n_out = int(round(samples.size * 16000 / src))
    idx = np.linspace(0.0, samples.size - 1.0, n_out)
    out = np.interp(idx, np.arange(samples.size), samples)
    # a little silence either side so the VAD sees clean boundaries
    pad = np.zeros(int(0.35 * 16000), dtype=np.float32)
    out = np.concatenate([pad, out, pad])
    return np.clip(out, -32768, 32767).astype(np.int16).tobytes()


def main() -> int:
    text = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TEXT
    pcm = synth_16k(text)
    with wave.open(OUT, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm)
    seconds = len(pcm) / (16000 * 2)
    print(f"wrote {OUT} ({seconds:.1f}s) for: {text!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())