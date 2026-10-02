import os, sys, wave, numpy as np
sys.path.insert(0, os.path.join("services", "voice", "src"))
from piper import PiperVoice
v = PiperVoice.load(os.environ["PIPER_VOICE"])
text = "How much is a premium styling and when are you open?"
parts, sr = [], 22050
for ch in v.synthesize(text):
    sr = ch.sample_rate
    parts.append(bytes(ch.audio_int16_bytes))
a = np.frombuffer(b"".join(parts), dtype=np.int16).astype(np.float32)
a = np.concatenate([np.zeros(int(sr*0.4)), a, np.zeros(int(sr*2.5))])
n = int(len(a) * 48000 / sr)
a = np.interp(np.linspace(0, len(a)-1, n), np.arange(len(a)), a).astype(np.int16)
out = os.path.join(os.environ["TEMP"], "voice_test.wav")
with wave.open(out, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000); w.writeframes(a.tobytes())
print("wrote", out, len(a)/48000, "s")
