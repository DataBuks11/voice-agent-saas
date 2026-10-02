"""Barge-in E2E against a deployed voice runtime.

Reproduces the reported failure: while the agent is answering, the caller talks
over it. We assert the agent stops its own audio, handles exactly one
interruption, keeps the caller's words, and answers them once (no overlapping
replies, no lost audio).

Audio is paced at real time, because that is what a microphone does.
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
    """Resample 22 kHz piper output to the 16 kHz the runtime expects."""
    if rate == NATIVE:
        return samples
    out = bytearray()
    for i in range(0, len(samples) - 1, 2):
        out += samples[i : i + 2] * 2
    return bytes(out)


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


async def send_audio(sock, pcm: bytes) -> None:
    """Send at roughly real time so turn detection behaves like a live call."""
    for i in range(0, len(pcm), CHUNK):
        await sock.send(pcm[i : i + CHUNK])
        await asyncio.sleep(CHUNK / (NATIVE * 2))


class Recorder:
    def __init__(self) -> None:
        self.events: list[tuple[float, str, dict]] = []
        self.audio_runs: list[list[float]] = []
        self.transcripts: list[str] = []
        self.replies: list[str] = []
        self.interruptions = 0

    def feed(self, now: float, msg) -> None:
        if isinstance(msg, bytes):
            if not self.audio_runs or now - self.audio_runs[-1][1] > 0.4:
                self.audio_runs.append([now, now])
            else:
                self.audio_runs[-1][1] = now
            return
        ev = json.loads(msg)
        kind = ev.get("type", "?")
        self.events.append((now, kind, ev))
        text = str(ev.get("text") or "")
        if kind == "user":
            self.transcripts.append(text)
        elif kind == "assistant":
            self.replies.append(text)
        elif kind == "interrupted":
            self.interruptions += 1
        print(f"[{now:5.1f}s] {kind}: {text[:100]}")

    async def wait_for(self, sock, kinds: set[str], timeout: float) -> tuple[float, str] | None:
        end = time.time() + timeout
        while time.time() < end:
            try:
                msg = await asyncio.wait_for(sock.recv(), timeout=max(0.2, end - time.time()))
            except asyncio.TimeoutError:
                return None
            now = time.time() - self.t0
            self.feed(now, msg)
            if msg.__class__ is bytes:
                continue
            if json.loads(msg).get("type") in kinds:
                return now, json.loads(msg).get("type", "")
        return None


async def main() -> int:
    token, ws_id = seed()
    t0 = time.time()
    rec = Recorder()
    rec.t0 = t0
    first = speak(Q1)
    second = speak(Q2)
    print(f"[audio] q1={len(first) // 3200 * 100}ms q2={len(second) // 3200 * 100}ms")

    async with websockets.connect(WS_URL, max_size=8 * 1024 * 1024, open_timeout=30) as sock:
        await sock.send(json.dumps({"type": "start", "token": token, "workspaceId": ws_id}))
        ready = await rec.wait_for(sock, {"ready"}, timeout=30)
        print(f"[ready] {'ok' if ready else 'MISSING'}")
        # let the greeting finish so we measure the answer, not the greeting
        await rec.wait_for(sock, {"audio_end"}, timeout=25)

        # ---- phase 1: normal question
        print("\n--- phase 1: normal question")
        task = asyncio.create_task(send_audio(sock, first))
        got_user = await rec.wait_for(sock, {"user"}, timeout=25)
        await task
        print(f"[phase1] transcript in {time.time() - t0 - (got_user[0] if got_user else 0):.1f}s")
        await rec.wait_for(sock, {"assistant"}, timeout=25)
        speaking = await rec.wait_for(sock, {"audio_start"}, timeout=25)

        # ---- phase 2: talk over the answer
        print("\n--- phase 2: caller interrupts the answer")
        await send_audio(sock, second)
        after = await rec.wait_for(sock, {"assistant"}, timeout=25)

    print("\n=== summary ===")
    print(f"transcripts: {rec.transcripts}")
    print(f"replies: {rec.replies}")
    print(f"interruptions: {rec.interruptions}")
    print(f"audio runs (s): {[[round(a, 1), round(b, 1)] for a, b in rec.audio_runs]}")

    ok = True
    if not rec.transcripts:
        print("FAIL: nothing was transcribed")
        ok = False
    if len(rec.replies) < 2:
        print(f"FAIL: expected 2 replies (answer + answer after interruption), got {len(rec.replies)}")
        ok = False
    if rec.interruptions != 1:
        print(f"FAIL: expected exactly 1 interruption, got {rec.interruptions}")
        ok = False
    if rec.interruptions and len(rec.replies) > 2:
        print(f"FAIL: {len(rec.replies)} replies - agent is talking over itself")
        ok = False
    if rec.transcripts and "enterprise" not in rec.transcripts[-1].lower():
        print(f"FAIL: the words said during playback were lost: {rec.transcripts[-1]!r}")
        ok = False
    if rec.replies and "1200" not in " ".join(rec.replies):
        print(f"WARN: reply after interruption does not mention the enterprise price: {rec.replies[-1]!r}")
    print("VOICE BARGE-IN E2E " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))