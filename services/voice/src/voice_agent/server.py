"""WebSocket voice runtime: mic PCM -> energy VAD -> STT -> API RAG/LLM -> TTS."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re

import httpx
from websockets.asyncio.server import serve

from .pipeline import VoiceConfig, VoicePipeline
from .providers import STTProvider, TTSProvider
from .real import ApiLLM, VoiceAuth, build_stt, build_tts
from .vad import Vad, VadConfig

log = logging.getLogger("voice.server")

API_BASE = os.getenv("API_BASE_URL", "http://127.0.0.1:3001").rstrip("/")
PORT = int(os.getenv("PORT", "8080"))
SAMPLE_RATE = 16000
FRAME_BYTES = SAMPLE_RATE // 50 * 2  # 20ms of PCM16 mono

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")


def _split_sentences(text: str) -> list[str]:
    parts = [p.strip() for p in _SENTENCE_SPLIT.split(text) if p.strip()]
    return parts or [text]

_stt: STTProvider | None = None
_tts: TTSProvider | None = None
_models_lock = asyncio.Lock()


async def shared_models() -> tuple[STTProvider, TTSProvider]:
    global _stt, _tts
    async with _models_lock:
        if _stt is None:
            _stt = await asyncio.to_thread(build_stt)
        if _tts is None:
            _tts = await asyncio.to_thread(build_tts)
        log.info("providers: stt=%s tts=%s", _stt.name, _tts.name)
        return _stt, _tts


class Session:
    def __init__(self, ws):
        self.ws = ws
        self.send_lock = asyncio.Lock()
        self.pipeline: VoicePipeline | None = None
        self.llm: ApiLLM | None = None
        self.vad = Vad(VadConfig(), SAMPLE_RATE)
        self.partial = bytearray()
        self.queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=2)
        self.worker: asyncio.Task | None = None
        self.interrupted = False
        self.turn_active = False
        self.started = False
        self.start_error_sent = False

    # --- wire helpers (serialize sends: audio + json interleave) ---
    async def send_json(self, obj: dict) -> None:
        async with self.send_lock:
            await self.ws.send(json.dumps(obj))

    async def send_bytes(self, data: bytes) -> None:
        async with self.send_lock:
            await self.ws.send(data)

    # --- session start ---
    async def start(self, msg: dict) -> None:
        token = msg.get("token")
        workspace_id = msg.get("workspaceId")
        agent_id = msg.get("agentId")
        auth: VoiceAuth | None = None

        if token and workspace_id:
            headers = {"Authorization": f"Bearer {token}", "x-workspace-id": workspace_id}
        elif os.getenv("VOICE_EMAIL") and os.getenv("VOICE_PASSWORD"):
            auth = VoiceAuth(API_BASE, os.environ["VOICE_EMAIL"], os.environ["VOICE_PASSWORD"])
            token = await auth.token()
            workspace_id = workspace_id or os.getenv("VOICE_WORKSPACE_ID")
            headers = {"Authorization": f"Bearer {token}"}
            if not workspace_id:
                workspace_id = await self._discover_workspace(headers)
                if not workspace_id:
                    async with httpx.AsyncClient(base_url=API_BASE, timeout=30.0) as c:
                        r = await c.post("/v1/workspaces", json={"name": "Voice Workspace"}, headers=headers)
                        r.raise_for_status()
                        workspace_id = r.json()["id"]
            headers["x-workspace-id"] = workspace_id
        else:
            await self.send_json({"type": "error", "reason": "start_required"})
            return

        async with httpx.AsyncClient(base_url=API_BASE, timeout=30.0) as c:
            body: dict = {"workspaceId": workspace_id, "channel": "voice"}
            if agent_id:
                body["agentId"] = agent_id
            r = await c.post("/v1/conversations", json=body, headers=headers)
            if r.status_code >= 400:
                log.error("conversation create failed: %s %s", r.status_code, r.text[:300])
                await self.send_json({"type": "error", "reason": "conversation_create_failed"})
                return
            conversation_id = r.json()["id"]

        stt, tts = await shared_models()
        self.llm = ApiLLM(API_BASE, workspace_id, conversation_id, agent_id=agent_id, auth=auth, token=token)
        cfg = VoiceConfig(
            allow_barge_in=os.getenv("VOICE_ALLOW_BARGE_IN", "true").lower() == "true",
            max_turns=int(os.getenv("VOICE_MAX_CONVERSATION_TURNS", "50")),
            sample_rate=SAMPLE_RATE,
        )
        self.pipeline = VoicePipeline(stt, self.llm, tts, cfg)
        self.started = True
        self.worker = asyncio.create_task(self._turn_worker())
        await self.send_json({"type": "ready", "conversationId": conversation_id, "workspaceId": workspace_id})
        log.info("session ready: workspace=%s conversation=%s", workspace_id, conversation_id)

    @staticmethod
    async def _discover_workspace(headers: dict) -> str | None:
        async with httpx.AsyncClient(base_url=API_BASE, timeout=30.0) as c:
            r = await c.get("/v1/workspaces", headers=headers)
            if r.status_code >= 400:
                return None
            items = r.json().get("items") or []
            return items[0]["id"] if items else None

    # --- turn loop ---
    async def _turn_worker(self) -> None:
        while True:
            pcm = await self.queue.get()
            self.interrupted = False
            self.turn_active = True
            try:
                async def on_transcript(text: str) -> None:
                    await self.send_json({"type": "user", "text": text})

                assert self.pipeline is not None
                answer = await self.pipeline.handle_audio(pcm, on_transcript=on_transcript)
                if answer and not self.interrupted:
                    await self.send_json({"type": "assistant", "text": answer})
                    # Sentence-streamed TTS: synthesize + ship sentence by sentence so
                    # first audio leaves before the whole reply is rendered.
                    started = False
                    for sentence in _split_sentences(answer):
                        if self.interrupted:
                            break
                        chunk = await self.pipeline.synthesize(sentence)
                        if not chunk.pcm16:
                            continue
                        if not started:
                            await self.send_json(
                                {"type": "audio_start", "sampleRate": chunk.sample_rate, "encoding": "pcm16le"}
                            )
                            started = True
                        data = chunk.pcm16
                        for i in range(0, len(data), 16384):
                            if self.interrupted:
                                break
                            await self.send_bytes(data[i : i + 16384])
                    if started:
                        await self.send_json({"type": "audio_end"})
            except Exception as exc:  # noqa: BLE001 - surface to client
                log.exception("turn failed")
                await self.send_json({"type": "error", "reason": "turn_failed", "message": str(exc)})
            finally:
                self.turn_active = False

    async def enqueue_utterance(self, pcm: bytes) -> None:
        if self.turn_active or not self.queue.empty():
            self.interrupted = True
            if self.queue.full():
                try:
                    self.queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
        await self.queue.put(pcm)

    # --- receive loop ---
    async def run(self) -> None:
        async for message in self.ws:
            if isinstance(message, bytes):
                if not self.started:
                    if os.getenv("VOICE_EMAIL") and os.getenv("VOICE_PASSWORD"):
                        await self.start({})
                    elif not self.start_error_sent:
                        self.start_error_sent = True
                        await self.send_json({"type": "error", "reason": "start_required"})
                        continue
                    else:
                        continue
                    if not self.started:
                        continue
                self.partial.extend(message)
                while len(self.partial) >= FRAME_BYTES:
                    frame = bytes(self.partial[:FRAME_BYTES])
                    del self.partial[:FRAME_BYTES]
                    event = self.vad.feed(frame)
                    if event == "endpoint":
                        pcm = self.vad.take()
                        if pcm and self.pipeline is not None:
                            await self.enqueue_utterance(pcm)
            else:
                try:
                    msg = json.loads(message)
                except json.JSONDecodeError:
                    continue
                kind = msg.get("type")
                if kind == "start":
                    await self.start(msg)
                elif kind == "interrupt":
                    self.interrupted = True
                    if self.pipeline is not None:
                        self.pipeline.handle_barge_in()
                elif kind == "ping":
                    await self.send_json({"type": "pong"})

    async def close(self) -> None:
        if self.worker:
            self.worker.cancel()
            try:
                await self.worker
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if self.llm:
            try:
                await self.llm.aclose()
            except Exception:  # noqa: BLE001
                pass


async def handler(ws) -> None:
    session = Session(ws)
    log.info("client connected: %s", ws.remote_address)
    try:
        await session.run()
    except Exception:  # noqa: BLE001 - connection dropped is normal
        log.info("connection closed abnormally")
    finally:
        await session.close()
        log.info("client disconnected")


async def serve_forever() -> None:
    await shared_models()
    async with serve(handler, "0.0.0.0", PORT, ping_interval=20, ping_timeout=20):
        log.info("voice runtime listening on 0.0.0.0:%s (api=%s)", PORT, API_BASE)
        await asyncio.Future()


def run() -> None:
    asyncio.run(serve_forever())
