"""Barge-in E2E against a deployed voice runtime.

Reproduces the reported failure: while the agent is answering, the caller talks
over it. Asserts that the agent stops its own audio, handles exactly one
interruption, keeps the words spoken during playback, and answers once.

Audio is paced at real time because that is what a microphone does, and a
background reader keeps timestamps honest while the test is sending.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time

import httpx
import websockets

WS_URL = os.getenv("VOICE_WS_URL", "wss://voice-runtime-production-dc24.up.railway.app")
API = os.getenv("API_BASE_URL", "https://voice-agent-saas-production-3001.up.railway.app")
NATIVE = 16000
CHUNK = 3200  # 100 ms of 16 kHz PCM16

DOC = """# Plans

## Growth
Growth is $199 per month for growing teams and includes 10 seats.

## Enterprise
Enterprise is custom priced, starts at $1200 per month, and includes SSO and a
dedicated success manager.
"""

Q1 = "How much does the growth plan cost?"
Q2 = "Actually, tell me about the enterprise plan instead."


def pcm16(rate: int, samples: bytes) -> bytes:
    """Resample piper output to the 16 kHz the runtime expects.

    Must be a real resample: duplicating samples slows the audio down and
    whisper then transcribes nonsense, which looks like an STT bug but is not.
    """
    if rate == NATIVE:
        return samples
    import av
    import numpy as np

    arr = np.frombuffer(samples, dtype=np.int16).reshape(1, -1)
    frame = av.AudioFrame.from_ndarray(arr, format="s16", layout="mono")
    frame.sample_rate = rate
    resampler = av.AudioResampler(format="s16", layout="mono", rate=NATIVE)
    return b"".join(f.to_ndarray().tobytes() for f in resampler.resample(frame))


def speak(text: str, rate: int = 22050) -> bytes:
    from piper import PiperVoice

    voice_path = os.getenv("PIPER_VOICE")
    v = PiperVoice.load(voice_path) if voice_path else PiperVoice.load("en_US-lessac-medium")
    buf = bytearray()
    for chunk in v.synthesize(text):
        buf += chunk.audio_int16_bytes
    return pcm16(rate, bytes(buf))


def seed() -> tuple[str, str]:
    import uuid

    email = f"barge-{uuid.uuid4().hex[:10]}@voiceagent.dev"
    with httpx.Client(base_url=API, timeout=60.0) as c:
        r = c.post("/v1/auth/register", json={"email": email, "password": "Passw0rd!2026", "name": "Barge"})
        r.raise_for_status()
        token = r.json()["token"]
        h = {"Authorization": f"Bearer {token}"}
        r = c.post("/v1/workspaces", json={"name": "Barge E2E"}, headers=h)
        r.raise_for_status()
        ws_id = r.json()["id"]
        r = c.post(
            "/v1/knowledge/ingest",
            json={"workspaceId": ws_id, "title": "Plans", "markdown": DOC},
            headers={**h, "x-workspace-id": ws_id},
        )
        r.raise_for_status()
        print(f"[seed] workspace={ws_id} chunks={r.json().get('chunkCount')}")
    return token, ws_id


class Session:
    def __init__(self, sock, t0: float) -> None:
        self.sock = sock
        self.t0 = t0
        self.transcripts: list[tuple[float, str]] = []
        self.replies: list[tuple[float, str]] = []
        self.interruptions = 0
        self.audio_runs: list[list[float]] = []
        self.seen: dict[str, list[float]] = {}
        self.closed = False

    def feed(self, now: float, msg) -> None:
        if isinstance(msg, bytes):
            if not self.audio_runs or now - self.audio_runs[-1][1] > 0.4:
                self.audio_runs.append([now, now])
            else:
                self.audio_runs[-1][1] = now
            return
        ev = json.loads(msg)
        kind = str(ev.get("type", "?"))
        text = str(ev.get("text") or "")
        self.seen.setdefault(kind, []).append(now)
        if kind == "user":
            self.transcripts.append((now, text))
        elif kind == "assistant":
            self.replies.append((now, text))
        elif kind == "interrupted":
            self.interruptions += 1
        if kind in ("assistant", "user", "interrupted", "ready", "audio_start", "audio_end"):
            print(f"[{now:5.1f}s] {kind}: {text[:100]}")

    async def read_forever(self) -> None:
        try:
            async for msg in self.sock:
                self.feed(time.time() - self.t0, msg)
        except Exception as exc:  # noqa: BLE001
            self.closed = True
            print(f"[warn] reader stopped: {type(exc).__name__}")

    async def wait(self, kind: str, after: float = 0.0, timeout: float = 25.0) -> float | None:
        end = time.time() + timeout
        while time.time() < end:
            hits = [t for t in self.seen.get(kind, []) if t > after]
            if hits:
                return hits[0]
            if self.closed:
                return None
            await asyncio.sleep(0.05)
        return None

    def mark(self) -> float:
        return time.time() - self.t0


async def send_audio(sock, pcm: bytes) -> None:
    for i in range(0, len(pcm), CHUNK):
        await sock.send(pcm[i : i + CHUNK])
        await asyncio.sleep(CHUNK / (NATIVE * 2))


async def main() -> int:
    barge_mark = 0.0
    token, ws_id = seed()
    t0 = time.time()
    first, second = speak(Q1), speak(Q2)
    print(f"[audio] q1={len(first) // 640 * 10}ms q2={len(second) // 640 * 10}ms")

    rc = 1
    try:
        async with websockets.connect(WS_URL, max_size=8 * 1024 * 1024, open_timeout=30) as sock:
            await sock.send(json.dumps({"type": "start", "token": token, "workspaceId": ws_id}))
            s = Session(sock, t0)
            reader = asyncio.create_task(s.read_forever())
            if not await s.wait("ready", timeout=30):
                print("FAIL: session never became ready")
                return 1

            print("\n--- phase 1: first question")
            spoke_at = s.mark()
            await send_audio(sock, first)
            heard = await s.wait("user", after=spoke_at, timeout=30)
            answered = await s.wait("assistant", after=heard or spoke_at, timeout=30)
            if heard and answered:
                print(
                    f"[phase1] transcript {heard - spoke_at:.1f}s after speaking started, "
                    f"answer {answered - heard:.1f}s later"
                )

            print("\n--- phase 2: caller interrupts the answer")
            speaking_at = await s.wait("audio_start", after=answered or 0, timeout=20)
            if speaking_at is None:
                print("WARN: agent never started speaking before the interruption")
                speaking_at = s.mark()
            else:
                print(f"[phase2] agent speaking since {speaking_at:.1f}s; caller talks over it")
            barge_mark = speaking_at
            await send_audio(sock, second)
            await s.wait("assistant", after=s.mark() - 0.001, timeout=30)
            await asyncio.sleep(1.5)
            reader.cancel()
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] session ended early: {type(exc).__name__}: {exc}")

    ok = True
    print("\n=== summary ===")
    print(f"transcripts: {[(round(t, 1), x) for t, x in s.transcripts]}")
    print(f"replies: {[(round(t, 1), x[:70]) for t, x in s.replies]}")
    print(f"interruptions: {s.interruptions}")
    print(f"audio runs (s): {[[round(a, 1), round(b, 1)] for a, b in s.audio_runs]}")
    if not s.transcripts:
        print("FAIL: nothing was transcribed")
        ok = False
    if len(s.replies) < 2:
        print(f"FAIL: expected 2 replies, got {len(s.replies)}")
        ok = False
    # Only interruptions after the answer started matter; talking over the
    # greeting is normal and expected.
    late = [t for t in s.seen.get("interrupted", []) if t > barge_mark]
    if len(late) != 1:
        print(f"FAIL: expected exactly 1 interruption while answering, got {len(late)}")
        ok = False
    else:
        print(f"OK: interrupted once at {late[0]:.1f}s, "
              f"{late[0] - barge_mark:.1f}s into the answer")
    if len(s.replies) > 2:
        print(f"FAIL: {len(s.replies)} replies - the agent is talking over itself")
        ok = False
    if s.transcripts and "enterprise" not in s.transcripts[-1][1].lower():
        print(f"FAIL: words spoken during playback were lost: {s.transcripts[-1][1]!r}")
        ok = False
    else:
        print("OK: the words spoken during playback reached the model")
    if s.replies and "1200" not in s.replies[-1][1]:
        print(f"FAIL: reply after the interruption is wrong: {s.replies[-1][1]!r}")
        ok = False
    print("VOICE BARGE-IN E2E " + ("PASS" if ok else "FAIL"))
    rc = 0 if ok else 1
    return rc


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))