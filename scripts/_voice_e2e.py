#!/usr/bin/env python3
"""Voice runtime E2E: seed tenant via API, speak (piper TTS) over WebSocket, assert STT+LLM+TTS.

Usage: python scripts/_voice_e2e.py [--url ws://localhost:8080] [--api https://...]
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import subprocess
import sys
import time
import uuid
import wave

import httpx
import numpy as np
import websockets

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services", "voice", "src"))

QUESTION = "How much does the growth plan cost?"
DOC = (
    "Pricing: Starter plan is $49 per month with 3 agents and 10,000 vector search queries. "
    "Growth plan is $199 per month for growing teams. Enterprise is custom priced. "
    "Support contact: support@voiceagent.dev, response within 4 hours."
)


def speak_to_pcm16(text: str) -> bytes:
    """piper TTS -> 16k PCM16 (what the browser would send)."""
    from piper import PiperVoice

    voice_path = os.getenv("PIPER_VOICE")
    v = PiperVoice.load(voice_path) if voice_path else PiperVoice.load("en_US-lessac-medium")
    parts = []
    sr = 22050
    for ch in v.synthesize(text):
        sr = ch.sample_rate
        parts.append(bytes(ch.audio_int16_bytes))
    audio = np.frombuffer(b"".join(parts), dtype=np.int16).astype(np.float32)
    if sr != 16000:
        target = int(len(audio) * 16000 / sr)
        audio = np.interp(np.linspace(0, len(audio) - 1, target), np.arange(len(audio)), audio)
    return audio.astype(np.int16).tobytes()


def write_wav(path: str, pcm: bytes, sr: int = 16000) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)


async def seed_tenant(api: str) -> tuple[str, str]:
    email = f"voice-e2e-{uuid.uuid4().hex[:10]}@voiceagent.dev"
    async with httpx.AsyncClient(base_url=api, timeout=60.0) as c:
        r = await c.post("/v1/auth/register", json={"email": email, "password": "Passw0rd!2026", "name": "VoiceE2E"})
        r.raise_for_status()
        token = r.json()["token"]
        h = {"Authorization": f"Bearer {token}"}
        r = await c.post("/v1/workspaces", json={"name": "Voice E2E"}, headers=h)
        r.raise_for_status()
        ws_id = r.json()["id"]
        r = await c.post(
            "/v1/knowledge/ingest",
            json={"workspaceId": ws_id, "title": "Pricing", "markdown": DOC},
            headers={**h, "x-workspace-id": ws_id},
        )
        r.raise_for_status()
        print(f"[seed] user={email} workspace={ws_id} chunks={r.json().get('chunkCount')}")
        return token, ws_id


async def run_session(url: str, api: str, token: str, ws_id: str, timeout: float, mode: str = "audio") -> int:
    if mode == "text":
        pcm = None
        print(f"[text] {QUESTION!r} (browser-STT turn — server STT skipped)")
    else:
        pcm = await asyncio.to_thread(speak_to_pcm16, QUESTION)
        silence = b"\x00" * (16000 * 2)  # 1s endpoint silence
        print(f"[audio] utterance {len(pcm)} bytes (~{len(pcm)/2/16000:.1f}s)")
    t0 = time.time()
    got = {"user": None, "assistant": None, "audio": 0, "ready": None, "errors": []}
    async with websockets.connect(url, max_size=2**24, open_timeout=30) as ws:
        await ws.send(json.dumps({"type": "start", "token": token, "workspaceId": ws_id}))
        if mode == "text":
            await ws.send(json.dumps({"type": "text", "text": QUESTION}))
        else:
            await ws.send(pcm + silence)
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
            except asyncio.TimeoutError:
                break
            if isinstance(msg, bytes):
                # Pre-answer audio = auto-greeting; only the answer's TTS counts.
                if got["assistant"]:
                    got["audio"] += len(msg)
                continue
            data = json.loads(msg)
            kind = data.get("type")
            if kind == "ready":
                got["ready"] = data
            elif kind == "user":
                got["user"] = data.get("text")
                print(f"[stt] {got['user']!r}  (+{time.time()-t0:.1f}s)")
            elif kind == "assistant":
                got["assistant"] = data.get("text")
                print(f"[llm] {got['assistant']!r}  (+{time.time()-t0:.1f}s)")
            elif kind == "audio_start":
                if got["assistant"]:
                    print(f"[tts] start sr={data.get('sampleRate')}")
            elif kind == "audio_end":
                if got["assistant"] and got["audio"] > 0:
                    print(f"[tts] end ({got['audio']} bytes)  (+{time.time()-t0:.1f}s)")
                    break
            elif kind == "error":
                got["errors"].append(data)
                print(f"[error] {data}")

    ok = True
    if not got["ready"]:
        print("FAIL: no ready"); ok = False
    if not got["user"]:
        print("FAIL: no transcript"); ok = False
    elif "growth" not in got["user"].lower():
        print(f"FAIL: transcript mismatch: {got['user']!r}"); ok = False
    if not got["assistant"]:
        print("FAIL: no assistant reply"); ok = False
    elif "199" not in got["assistant"]:
        print(f"FAIL: reply not grounded in knowledge: {got['assistant'][:200]!r}"); ok = False
    if got["audio"] <= 0:
        print("FAIL: no TTS audio"); ok = False
    if got["errors"]:
        print(f"FAIL: errors {got['errors']}"); ok = False
    print(f"VOICE E2E[{mode}] " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.getenv("VOICE_URL", "wss://voice-runtime-production-dc24.up.railway.app"))
    ap.add_argument("--api", default=os.getenv("API_BASE_URL", "https://voice-agent-saas-production-3001.up.railway.app"))
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--mode", choices=["audio", "text", "both"], default=os.getenv("VOICE_E2E_MODE", "both"))
    args = ap.parse_args()

    # Each mode runs in its own process: a completed audio session leaves the
    # shared runtime busy long enough to swallow the next connection's frames.
    if args.mode == "both":
        token = os.environ.get("VOICE_E2E_TOKEN")
        ws_id = os.environ.get("VOICE_E2E_WS")
        if not token or not ws_id:
            token, ws_id = asyncio.run(seed_tenant(args.api))
        env = {**os.environ, "VOICE_E2E_TOKEN": token, "VOICE_E2E_WS": ws_id}
        rc = 0
        for mode in ("audio", "text"):
            print(f"\n=== {mode} session ===")
            child = subprocess.run(
                [sys.executable, __file__, "--url", args.url, "--api", args.api, "--timeout", str(args.timeout), "--mode", mode],
                env=env,
            )
            rc |= child.returncode
        return rc

    token = os.environ.get("VOICE_E2E_TOKEN")
    ws_id = os.environ.get("VOICE_E2E_WS")
    if not token or not ws_id:
        token, ws_id = asyncio.run(seed_tenant(args.api))
    return asyncio.run(run_session(args.url, args.api, token, ws_id, args.timeout, mode=args.mode))


if __name__ == "__main__":
    raise SystemExit(main())
