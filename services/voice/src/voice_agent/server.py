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
from .real import ApiLLM, VoiceAuth, build_stt, build_tts, set_stt_dictionary
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
_models_warmed = False

# Short acknowledgements are synthesised once at boot and replayed from memory, so
# the customer hears "Got it" within milliseconds of finishing their sentence
# instead of dead air while the model thinks.
BACKCHANNELS = ["Got it.", "Sure, one moment.", "Okay.", "Thank you.", "You're welcome."]
_tts_cache: dict[str, object] = {}
_TTS_CACHE_MAX = 240
_first_backchannel = 0


def _cache_key(text: str) -> str:
    return " ".join(text.lower().split())


async def cached_synthesize(tts: TTSProvider, text: str) -> object | None:
    """Memoised synthesis for short phrases (backchannels, confirmations)."""
    key = _cache_key(text)
    hit = _tts_cache.get(key)
    if hit is not None:
        return hit
    if len(key) > 60 or len(key) < 2:
        return None
    chunk = await tts.synthesize(text)
    if not chunk or not chunk.pcm16:
        return None
    if len(_tts_cache) >= _TTS_CACHE_MAX:
        _tts_cache.pop(next(iter(_tts_cache)), None)
    _tts_cache[key] = chunk
    return chunk


async def warm_backchannels(tts: TTSProvider) -> None:
    for phrase in BACKCHANNELS:
        try:
            await cached_synthesize(tts, phrase)
        except Exception:  # noqa: BLE001 - backchannel is best-effort
            log.debug("backchannel warm failed for %r", phrase, exc_info=True)
    log.info("backchannels ready: %d", len(_tts_cache))


async def shared_models() -> tuple[STTProvider, TTSProvider]:
    global _stt, _tts, _models_warmed
    async with _models_lock:
        if _stt is None:
            _stt = await asyncio.to_thread(build_stt)
        if _tts is None:
            _tts = await asyncio.to_thread(build_tts)
        if not _models_warmed:
            # First real turn must not pay lazy-init cost (onnx session, thread
            # pools, HF revision) — run one throwaway STT+TTS at boot instead.
            t0 = __import__("time").time()
            try:
                await _stt.transcribe(b"\x00" * 3200, SAMPLE_RATE)
                await _tts.synthesize("Warm up.")
                await warm_backchannels(_tts)
                backup = getattr(_tts, "backup", None)
                if backup is not None:
                    await backup.synthesize("Warm up.")
                log.info("providers warmed in %.2fs", __import__("time").time() - t0)
            except Exception:  # noqa: BLE001 - warming must never block startup
                log.exception("provider warm-up failed (continuing)")
            _models_warmed = True
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
        self.queue: asyncio.Queue[tuple[str, bytes | str]] = asyncio.Queue(maxsize=2)
        self.worker: asyncio.Task | None = None
        self.interrupted = False
        self.turn_active = False
        self.started = False
        self.start_error_sent = False
        self.greet_task: asyncio.Task | None = None

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
            conversation_payload = r.json() or {}
            conversation_id = str(conversation_payload.get("id") or "")

        stt, tts = await shared_models()
        self.llm = ApiLLM(API_BASE, workspace_id, conversation_id, agent_id=agent_id, auth=auth, token=token)
        # Match the caller's language end to end: STT decoder + neural voice.
        language = str((conversation_payload or {}).get("language") or "en")
        for provider in (stt, tts):
            setter = getattr(provider, "set_language", None)
            if callable(setter):
                setter(language)
        asyncio.create_task(self._load_dictionary(headers))
        cfg = VoiceConfig(
            allow_barge_in=os.getenv("VOICE_ALLOW_BARGE_IN", "true").lower() == "true",
            max_turns=int(os.getenv("VOICE_MAX_CONVERSATION_TURNS", "50")),
            sample_rate=SAMPLE_RATE,
        )
        self.pipeline = VoicePipeline(stt, self.llm, tts, cfg)
        self.started = True
        self.worker = asyncio.create_task(self._turn_worker())
        await self.send_json(
            {
                "type": "ready",
                "conversationId": conversation_id,
                "workspaceId": workspace_id,
                "language": str(conversation_payload.get("language") or "en"),
            }
        )
        log.info("session ready: workspace=%s conversation=%s", workspace_id, conversation_id)
        # Instant greeting: the agent speaks the moment the call connects —
        # no mic round-trip needed to feel "answered". VOICE_GREETING=off disables.
        greeting = os.getenv(
            "VOICE_GREETING",
            "Hi, thanks for calling! Go ahead whenever you're ready.",
        )
        if greeting and greeting.strip().lower() not in {"off", "none", "disabled", "false"}:
            self.greet_task = asyncio.create_task(self._auto_greet(greeting.strip()))

    async def _load_dictionary(self, headers: dict) -> None:
        """Prime the recogniser with this workspace's names and terms."""
        try:
            async with httpx.AsyncClient(base_url=API_BASE, timeout=10.0) as c:
                r = await c.get("/v1/agents/speech-dictionary", headers=headers)
                if r.status_code == 200:
                    set_stt_dictionary(list((r.json() or {}).get("terms") or []))
        except Exception:  # noqa: BLE001 - biasing is best-effort
            log.debug("speech dictionary unavailable", exc_info=True)

    @staticmethod
    async def _discover_workspace(headers: dict) -> str | None:
        async with httpx.AsyncClient(base_url=API_BASE, timeout=30.0) as c:
            r = await c.get("/v1/workspaces", headers=headers)
            if r.status_code >= 400:
                return None
            items = r.json().get("items") or []
            return items[0]["id"] if items else None

    # --- turn loop ---
    async def _speak(self, text: str, *, is_greeting: bool = False) -> None:
        """Sentence-streamed TTS: synthesize + ship sentence by sentence so
        first audio leaves before the whole reply is rendered."""
        import time as _time

        t0 = _time.time()
        t_first: float | None = None
        started = False
        for sentence in _split_sentences(text):
            if self.interrupted:
                break
            # A queued user utterance cancels the greeting so answers never overlap.
            if is_greeting and self.turn_active:
                break
            chunk = await self.pipeline.synthesize(sentence) if self.pipeline else None
            if not chunk or not chunk.pcm16:
                continue
            if not started:
                await self.send_json(
                    {"type": "audio_start", "sampleRate": chunk.sample_rate, "encoding": "pcm16le"}
                )
                started = True
                t_first = _time.time()
            data = chunk.pcm16
            for i in range(0, len(data), 16384):
                if self.interrupted or (is_greeting and self.turn_active):
                    break
                await self.send_bytes(data[i : i + 16384])
        if started:
            await self.send_json({"type": "audio_end"})
        log.info(
            "stage speak first=%s total=%.2fs greeting=%s",
            f"{t_first - t0:.2f}s" if t_first else "none",
            _time.time() - t0,
            is_greeting,
        )

    async def _auto_greet(self, text: str) -> None:
        try:
            if self.turn_active:
                return
            await self._speak(text, is_greeting=True)
        except Exception:  # noqa: BLE001 - greeting is best-effort
            log.exception("auto greeting failed")

    async def _turn_worker(self) -> None:
        while True:
            kind, payload = await self.queue.get()
            self.interrupted = False
            self.turn_active = True
            try:
                assert self.pipeline is not None

                async def on_transcript(text: str) -> None:
                    await self.send_json({"type": "user", "text": text})
                    await self._send_backchannel()

                if kind == "text":
                    answer = await self.pipeline.handle_text(payload, on_transcript=on_transcript)
                else:
                    answer = await self.pipeline.handle_audio(payload, on_transcript=on_transcript)
                if answer and not self.interrupted:
                    await self.send_json({"type": "assistant", "text": answer})
                    await self._speak(answer)
            except Exception as exc:  # noqa: BLE001 - surface to client
                log.exception("turn failed")
                await self.send_json({"type": "error", "reason": "turn_failed", "message": str(exc)})
            finally:
                self.turn_active = False

    async def _send_backchannel(self) -> None:
        """Pre-cached acknowledgement so the caller never hears dead air.

        The client holds it for ~300ms and drops it if the real answer arrives
        first, so fast turns stay clean and slow turns get instant feedback.
        """
        global _first_backchannel
        tts = _tts
        if tts is None or self.interrupted:
            return
        phrase = BACKCHANNELS[_first_backchannel % len(BACKCHANNELS)]
        _first_backchannel += 1
        try:
            chunk = await cached_synthesize(tts, phrase)
        except Exception:  # noqa: BLE001 - never break a turn for a filler
            log.debug("backchannel failed", exc_info=True)
            return
        if chunk is None or not getattr(chunk, "pcm16", b"") or self.interrupted:
            return
        await self.send_json(
            {
                "type": "backchannel",
                "text": phrase,
                "sampleRate": chunk.sample_rate,
                "encoding": "pcm16le",
            }
        )
        data = chunk.pcm16
        for i in range(0, len(data), 16384):
            await self.send_bytes(data[i : i + 16384])

    async def enqueue(self, kind: str, payload) -> None:
        if self.turn_active or not self.queue.empty():
            self.interrupted = True
            if self.queue.full():
                try:
                    self.queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
        await self.queue.put((kind, payload))

    async def enqueue_utterance(self, pcm: bytes) -> None:
        await self.enqueue("audio", pcm)

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
                    if event == "speech_start":
                        # Immediate UI feedback: the orb reacts while the caller is
                        # still speaking, not only after transcription finishes.
                        await self.send_json({"type": "hearing"})
                    elif event == "endpoint":
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
                elif kind == "text":
                    # Browser Web Speech API transcript — STT already done client-side.
                    text = str(msg.get("text") or "").strip()
                    if text and self.started and self.pipeline is not None:
                        await self.enqueue("text", text)
                elif kind == "interrupt":
                    self.interrupted = True
                    if self.pipeline is not None:
                        self.pipeline.handle_barge_in()
                elif kind == "ping":
                    await self.send_json({"type": "pong"})

    async def close(self) -> None:
        if self.greet_task:
            self.greet_task.cancel()
            try:
                await self.greet_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
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
