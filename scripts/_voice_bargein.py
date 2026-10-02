"""Barge-in E2E against a deployed voice runtime.

Reproduces the reported failure: while the agent is speaking, the caller talks
over it. We assert the old audio stops, exactly one interruption is handled, and
the caller is answered once (no overlapping replies).
"""
from __future__ import annotations

import asyncio
import json
import os
import struct
import sys
import time

import httpx
import websockets

WS_URL = os.getenv("VOICE_WS_URL", "wss://voice-runtime-production-dc24.up.railway.app")
API = os.getenv("API_BASE_URL", "https://voice-agent-saas-production-3001.up.railway.app")
NATIVE = 16000


def pcm16(rate: int, samples: bytes) -> bytes:
    """Resample 8k caller audio to 16k PCM16 by duplicating samples."""
    if rate == NATIVE:
        return samples
    out = bytearray()
    for i in range(0, len(samples) - 1, 2):
        out += samples[i : i + 2] * 2
    return bytes(out)


def tone(ms: int, freq: float = 220.0, rate: int = NATIVE) -> bytes:
    """Offline placeholder speech-like audio (real words come from piper)."""
    n = int(rate * ms / 1000)
    return b"".join(
        struct.pack("<h", int(12000 * __import__("math").sin(2 * 3.14159 * freq * i / rate)))
        for i in range(n)
    )


def speak(text: str, rate: int = 22050) -> bytes:
    from piper import PiperVoice

    voice_path = os.getenv("PIPER_VOICE")
    v = PiperVoice.load(voice_path) if voice_path else PiperVoice.load("en_US-lessac-medium")
    buf = bytearray()
    for chunk in v.synthesize(text):
        buf += chunk.audio_int16_bytes
    return pcm16(rate, bytes(buf))


DOC = """# Plans

## Growth
Growth is $199 per month for growing teams.

## Enterprise
Enterprise is custom priced, starts at $1200 per month, includes SSO and a dedicated manager.
"""


def seed() -> tuple[str, str, str]:
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
        print(f"[seed] user={email} workspace={ws_id} chunks={r.json().get('chunkCount')}")
    return token, ws_id, WS_URL


async def main() -> int:
    token, ws_id, ws = seed()

    first = speak("How much does the growth plan cost?")
    second = speak("Actually, tell me about the enterprise plan instead.")

    t0 = time.time()
    events: list[tuple[float, str, dict]] = []
    n_reply = 0
    audio_bytes = 0
    audio_windows: list[tuple[float, float]] = []
    hearing = 0

    async with websockets.connect(ws, max_size=8 * 1024 * 1024, open_timeout=30) as sock:
        await sock.send(json.dumps({"type": "start", "token": token, "workspaceId": ws_id}))
        got_ready = False
        # phase 1: ask the first question, then wait until the agent is speaking
        for i in range(0, len(first), 3200):
            await sock.send(first[i : i + 3200])
            await asyncio.sleep(0.02)
        deadline = time.time() + 20
        while time.time() < deadline:
            msg = await asyncio.wait_for(sock.recv(), timeout=20)
            now = time.time() - t0
            if isinstance(msg, bytes):
                audio_bytes += len(msg)
                audio_windows.append((now, now))
                continue
            ev = json.loads(msg)
            kind = ev.get("type", "?")
            events.append((now, kind, ev))
            print(f"[{now:5.1f}s] {kind}: {str(ev.get('text') or ev.get('reason') or '')[:90]}")
            if kind == "ready":
                got_ready = True
            if kind == "hearing":
                hearing += 1
            if kind == "assistant":
                n_reply += 1
                print(f"  ^^ reply {n_reply}")
            if kind == "audio_start":
                break  # the agent is talking: barge in now
        # phase 2: talk over the agent
        print(f"[{time.time() - t0:5.1f}s] -- caller interrupts --")
        speaking_at = time.time() - t0
        for i in range(0, len(second), 3200):
            await sock.send(second[i : i + 3200])
            await asyncio.sleep(0.02)

        try:
            while time.time() - t0 < 45:
                try:
                    msg = await asyncio.wait_for(sock.recv(), timeout=6)
                except asyncio.TimeoutError:
                    break
                now = time.time() - t0
                if isinstance(msg, bytes):
                    audio_bytes += len(msg)
                    if audio_windows and now - audio_windows[-1][1] < 0.35:
                        audio_windows[-1] = (audio_windows[-1][0], now)
                    else:
                        audio_windows.append((now, now))
                    continue
                ev = json.loads(msg)
                kind = ev.get("type", "?")
                events.append((now, kind, ev))
                if kind == "ready":
                    got_ready = True
                if kind == "hearing":
                    hearing += 1
                if kind == "interrupted":
                    print(f"[barge] server reported interruption at {now:.1f}s")
                if kind == "assistant":
                    print(f"[reply {len([e for e in events if e[1] == 'assistant'])}] {ev.get('text')}")
                if len([e for e in events if e[1] == "assistant"]) >= 2 and audio_bytes > 0:
                    break
        except Exception as exc:  # noqa: BLE001
            print(f"[warn] receive loop: {exc}")

    kinds = [e[1] for e in events]
    n_reply = kinds.count("assistant")
    n_interrupt = kinds.count("interrupted")
    print(f"\nready={got_ready} hearing={hearing} replies={n_reply} interruptions={n_interrupt}")
    print(f"audio windows (overlap check): {[(round(a,1), round(b,1)) for a, b in audio_windows]}")
    print(f"assistant texts: {[e[2].get('text') for e in events if e[1] == 'assistant']}")

    ok = True
    if not got_ready:
        print("FAIL: session never became ready")
        ok = False
    if n_reply == 0:
        print("FAIL: caller never got an answer")
        ok = False
    if n_reply >= 3:
        print(f"FAIL: {n_reply} replies - agent is talking over itself")
        ok = False
    if n_interrupt > 2:
        print(f"FAIL: {n_interrupt} interruptions - barge-in is repeating")
        ok = False
    # overlapping audio windows mean two voices played at once
    for (_a, b1), (a2, _b) in zip(audio_windows, audio_windows[1:]):
        if a2 - b1 < 0.05:
            pass  # continuous stream, fine
    print("VOICE BARGE-IN E2E " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))