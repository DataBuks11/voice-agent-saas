"""WebSocket voice runtime: mic PCM -> energy VAD -> STT -> API RAG/LLM -> TTS."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import uuid

import httpx
from websockets.asyncio.server import serve

from .contract import MIC, validate_mic_frame
from .orchestrator import (
    ConversationEngine,
    EventType,
    TranscriptNormalizer,
    Turn,
    VoiceOrchestrator,
    split_for_tts,
)
from .pipeline import VoiceConfig, VoicePipeline
from .providers import STTProvider, TTSProvider
from .real import ApiLLM, VoiceAuth, build_stt, build_tts, set_stt_dictionary
from .vad import Vad, VadConfig

log = logging.getLogger("voice.server")

API_BASE = os.getenv("API_BASE_URL", "http://127.0.0.1:3001").rstrip("/")
PORT = int(os.getenv("PORT", "8080"))
SAMPLE_RATE = 16000
FRAME_MS = 20  # PCM16 mono, 20 ms per frame
FRAME_BYTES = SAMPLE_RATE // 1000 * FRAME_MS * 2

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")


def _split_sentences(text: str) -> list[str]:
    parts = [p.strip() for p in _SENTENCE_SPLIT.split(text) if p.strip()]
    return parts or [text]

_stt: STTProvider | None = None
_tts: TTSProvider | None = None
_models_lock = asyncio.Lock()
_models_warmed = False

# How much speech to accumulate before running a speculative transcript
# (draft). ~700ms keeps the draft warm without flooding the transcriber.
STT_CHUNK_BYTES = max(6000, int(float(os.getenv("STT_CHUNK_MS", "900")) * 32))

# Speaker bleed reaches the mic a moment after our audio starts; ignore that window.
ECHO_GUARD_S = float(os.getenv("ECHO_GUARD_S", "0.12"))
# Expressed in 20 ms frames so the guard follows audio time, not wall-clock.
ECHO_GUARD_FRAMES = max(0, int(ECHO_GUARD_S * 1000 / FRAME_MS))
# How much post-guard audio to keep while we speak (~3 s of 16 kHz PCM16).
INTERRUPT_KEEP_BYTES = 16000 * 2 * 3
# How long the endpoint waits for the in-flight model warm-up before answering anyway.
# Race the draft: if it lands within this window the answer comes from cache,
# otherwise answer immediately rather than making the caller wait for it.
DRAFT_JOIN_TIMEOUT = float(os.getenv("DRAFT_JOIN_TIMEOUT_S", "0.8"))

# Don't speculate on short replies ("yes", "okay") - it only burns CPU.
STT_DRAFT_MIN_BYTES = int(float(os.getenv("STT_DRAFT_MIN_MS", "1200")) * 32)

# Streaming deltas only pay off once the caller has been talking a while. Short
# replies are transcribed in a single pass at the endpoint, which is faster.
STT_DELTA_MIN_BYTES = int(float(os.getenv("STT_DELTA_MIN_MS", "2500")) * 32)

# Short acknowledgements are synthesised once at boot and replayed from memory, so
# the customer hears "Got it" within milliseconds of finishing their sentence
# instead of dead air while the model thinks.
BACKCHANNELS = ["Got it.", "Sure, one moment.", "Okay.", "Thank you.", "You're welcome."]
_tts_cache: dict[str, object] = {}
_TTS_CACHE_MAX = 240
_first_backchannel = 0

# "hello", "yes", "okay", "thanks" and the like: the real reply is fast, so a
# filler would be the only thing the caller hears.
_TOO_SHORT_FOR_BACKCHANNEL = {
    "hi", "hello", "hey", "yo", "yes", "yeah", "yep", "no", "nope", "ok", "okay", "k",
    "sure", "thanks", "thank you", "bye", "goodbye", "cool", "nice", "great", "fine",
    "right", "correct", "exactly", "hmm", "ha", "haha", "wow", "oh", "please", "there",
    "hello there", "good morning", "good afternoon", "good evening",
}


def _wants_backchannel(transcript: str) -> bool:
    text = (transcript or "").lower().strip(" .!?,")
    if not text:
        return False
    if text in _TOO_SHORT_FOR_BACKCHANNEL:  # "thank you", "good morning"
        return False
    words = [w for w in re.split(r"[^a-z']+", text) if w]
    if len(words) <= 2 and all(w in _TOO_SHORT_FOR_BACKCHANNEL for w in words):
        return False
    return True


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


def metric_or_zero(value: float | None) -> float:
    return float(value or 0.0)


def workspace_id_hint(session: "Session") -> str:
    return str(getattr(session, "workspace_id", "") or "")


class Session:
    def __init__(self, ws):
        self.ws = ws
        self.send_lock = asyncio.Lock()
        self.pipeline: VoicePipeline | None = None
        self.llm: ApiLLM | None = None
        self.vad = Vad(VadConfig(), SAMPLE_RATE)
        self.partial = bytearray()
        self.queue: asyncio.Queue[tuple[str, bytes | str, Turn | None]] = asyncio.Queue(maxsize=2)
        self.worker: asyncio.Task | None = None
        self.interrupted = False
        self.turn_active = False
        self.started = False
        self._drafting = False
        self._draft_task: asyncio.Task | None = None
        self._draft_api_task: asyncio.Task | None = None
        self._stt_consumed = 0
        self._hyp_parts: list[str] = []
        self.hypothesis = ""
        self.start_error_sent = False
        self.greet_task: asyncio.Task | None = None
        # Half-duplex state: while the agent is speaking the microphone is muted
        # and speaker bleed is ignored, so the agent can never answer itself.
        self.speaking = False
        self._echo_candidate = False
        # Speaker bleed needs a moment to reach the mic; ignore that onset window.
        self._echo_guard_frames = 0
        self._barge_taken = False
        # Audio captured after the echo guard while we speak, kept in case the
        # caller really is interrupting.
        self._interrupt_buf = bytearray()
        self.last_activity = __import__("time").time()
        self.call_started = self.last_activity
        self.idle_nudges = 0
        self.watchdog: asyncio.Task | None = None
        self.turn_watchdog: asyncio.Task | None = None
        self._last_frame_at = __import__("time").time()
        # Staged orchestrator: owns turns, events and cancellation.
        self.session_id = uuid.uuid4().hex[:12]
        self.orch: VoiceOrchestrator | None = None
        self.trace_to_client = os.getenv("VOICE_TRACE", "").lower() in ("1", "true", "on")
        self._audio_seq = 0

    # --- wire helpers (serialize sends: audio + json interleave) ---
    async def send_json(self, obj: dict) -> None:
        async with self.send_lock:
            await self.ws.send(json.dumps(obj))

    async def send_bytes(self, data: bytes) -> None:
        async with self.send_lock:
            await self.ws.send(data)

    # --- session start ---
    async def start(self, msg: dict) -> None:
        try:
            await self._start(msg)
        except asyncio.CancelledError:  # pragma: no cover
            raise
        except Exception as exc:  # noqa: BLE001 - a failed start must be visible
            log.exception("session start failed")
            with contextlib.suppress(Exception):
                await self.send_json({"type": "error", "reason": "start_failed", "message": str(exc)})

    async def _start(self, msg: dict) -> None:
        token = msg.get("token")
        workspace_id = msg.get("workspaceId")
        agent_id = msg.get("agentId")
        auth: VoiceAuth | None = None
        # Load the speech models while the conversation is being created: on a
        # freshly booted container this is seconds of work that used to happen
        # after the API round trip, and the greeting waited for all of it.
        models_task = asyncio.create_task(shared_models())

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

        stt, tts = await models_task
        self.llm = ApiLLM(API_BASE, workspace_id, conversation_id, agent_id=agent_id, auth=auth, token=token)
        # Match the caller's language end to end: STT decoder + neural voice.
        language = str((conversation_payload or {}).get("language") or "en")
        for provider in (stt, tts):
            setter = getattr(provider, "set_language", None)
            if callable(setter):
                setter(language)
        asyncio.create_task(self._load_dictionary(headers, workspace_id))
        cfg = VoiceConfig(
            allow_barge_in=os.getenv("VOICE_ALLOW_BARGE_IN", "true").lower() == "true",
            max_turns=int(os.getenv("VOICE_MAX_CONVERSATION_TURNS", "50")),
            sample_rate=SAMPLE_RATE,
        )
        self.pipeline = VoicePipeline(stt, self.llm, tts, cfg)
        self.workspace_id = workspace_id
        self._build_orchestrator(cfg.allow_barge_in)
        self.started = True
        self.call_started = __import__("time").time()
        self.last_activity = self.call_started
        self.worker = asyncio.create_task(self._turn_worker())
        await self._start_watchdog()
        await self.send_json(
            {
                "type": "ready",
                "sessionId": self.session_id,
                "conversationId": conversation_id,
                "workspaceId": workspace_id,
                "language": str(conversation_payload.get("language") or "en"),
                "audio": MIC.to_dict(),
                "stt": getattr(stt, "describe", lambda: {})(),
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

    def _build_orchestrator(self, allow_barge_in: bool = True) -> None:
        """Stages + turn ownership. Business logic stays in the pipeline."""
        assert self.pipeline is not None
        pipeline = self.pipeline

        async def complete(transcript: str, history: str) -> str:
            # The API owns RAG, capture, availability, booking and the LLM.
            return await pipeline.llm.complete(
                system="You are a helpful voice assistant.",
                context=history,
                user=transcript,
            )

        async def on_audio(pcm: bytes, rate: int, turn: Turn) -> None:
            await self._send_audio_chunk(pcm, rate, turn)

        orch = VoiceOrchestrator(
            self.session_id,
            engine=ConversationEngine(complete, pipeline.state.history_text),
            on_audio=on_audio,
            normalizer=TranscriptNormalizer(),
            allow_barge_in=allow_barge_in,
        )

        async def forward(event) -> None:
            if not self.trace_to_client:
                return
            await self.send_json({"type": "trace", **event.to_dict()})

        orch.bus.subscribe(forward)
        self.orch = orch
        self.session_id = orch.session_id
        self.orch.bus.emit(EventType.VOICE_SESSION_STARTED, None, workspaceId=workspace_id_hint(self))

    async def _send_audio_chunk(self, pcm: bytes, rate: int, turn: Turn | None) -> None:
        """One ordered, sequence-numbered audio frame on the wire."""
        if self.orch is not None and turn is not None and not self.orch.turns.is_live(turn):
            return  # cancelled turn: the audio must never reach the speaker
        self._audio_seq += 1
        await self.send_bytes(pcm)
        if self.orch is not None:
            self.orch.bus.emit(
                EventType.AUDIO_QUEUE_ADD, turn.turn_id if turn else None, seq=self._audio_seq, bytes=len(pcm)
            )

    async def _load_dictionary(self, headers: dict, workspace_id: str | None) -> None:
        """Prime the recogniser with this workspace's names and terms."""
        if not workspace_id:
            return
        try:
            async with httpx.AsyncClient(base_url=API_BASE, timeout=10.0) as c:
                r = await c.get(
                    "/v1/agents/speech-dictionary",
                    headers=headers,
                    params={"workspaceId": workspace_id},
                )
                if r.status_code == 200:
                    terms = list((r.json() or {}).get("terms") or [])
                    set_stt_dictionary(terms)
                    log.info("speech dictionary: %d terms", len(terms))
                else:
                    log.warning("speech dictionary unavailable: HTTP %s", r.status_code)
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
    async def _speak(self, text: str, *, is_greeting: bool = False, turn: Turn | None = None) -> None:
        """Stream TTS sentence by sentence, owned by one turn.

        Phrase boundaries only (never half a sentence), and nothing is shipped if
        the turn was cancelled while the synthesiser was working.
        """
        import time as _time

        t0 = _time.time()
        t_first: float | None = None
        started = False
        total_bytes = 0
        out_rate = SAMPLE_RATE
        orch = self.orch
        # With a turn owner, cancellation is per turn. The legacy global flag is
        # only consulted for turn-less playback (greeting), otherwise a queued
        # utterance would silence an answer that is still perfectly valid.
        def cancelled() -> bool:
            if turn is not None:
                return orch is not None and not orch.turns.is_live(turn)
            return self.interrupted

        for phrase in split_for_tts(text):
            if cancelled():
                log.info("speak cancelled before %r", phrase[:32])
                break
            if turn is not None and orch is not None and not orch.turns.is_live(turn):
                log.info("dropping cancelled TTS for %s", turn.turn_id)
                break
            # A queued user utterance cancels the greeting so answers never overlap.
            if is_greeting and self.turn_active:
                break
            if orch is not None:
                orch.bus.emit(EventType.TTS_STARTED, turn.turn_id if turn else None, chars=len(phrase))
            chunk = await self.pipeline.synthesize(phrase) if self.pipeline else None
            if not chunk or not chunk.pcm16:
                continue
            if not started:
                await self.send_json(
                    {
                        "type": "audio_start",
                        "sampleRate": chunk.sample_rate,
                        "encoding": "pcm16le",
                        "turnId": turn.turn_id if turn else None,
                    }
                )
                # Half-duplex: ignore the echo of our own voice while it plays.
                self.speaking = True
                self._echo_candidate = False
                self._echo_guard_frames = ECHO_GUARD_FRAMES
                self._interrupt_buf.clear()
                self.vad.reset()
                await self.send_json({"type": "speak_start", "turnId": turn.turn_id if turn else None})
                if orch is not None:
                    if turn is not None:
                        orch.speaking_started(turn)
                    else:
                        # Greeting/backchannel: audio is playing but no turn owns it.
                        orch.assistant_audio_started()
                started = True
                t_first = _time.time()
            out_rate = chunk.sample_rate or SAMPLE_RATE
            data = chunk.pcm16
            total_bytes += len(data)
            for i in range(0, len(data), 16384):
                if cancelled() or (is_greeting and self.turn_active):
                    break
                await self._send_audio_chunk(data[i : i + 16384], out_rate, turn)
            if orch is not None:
                orch.bus.emit(
                    EventType.TTS_COMPLETED, turn.turn_id if turn else None, phrase=True
                )
        if started:
            await self.send_json({"type": "audio_end", "turnId": turn.turn_id if turn else None})
            # The client buffers audio, so we are still speaking after the last byte.
            playback_s = total_bytes / float(out_rate * 2)
            if t_first is not None and not cancelled():
                remaining = (t_first + playback_s) - _time.time()
                if 0 < remaining < 30:
                    await asyncio.sleep(remaining)
            self.speaking = False
            self._echo_candidate = False
            await self.send_json({"type": "speak_end", "turnId": turn.turn_id if turn else None})
            if self._barge_taken and self.vad.in_speech:
                # They are still talking: let the endpoint capture the sentence.
                pass
            elif self._barge_taken:
                await self._flush_interruption()
            else:
                # Pure playback bleed: throw it away.
                self.vad.reset()
            self._barge_taken = False
            if orch is not None:
                if turn is not None and orch.turns.is_live(turn):
                    orch.speaking_finished(turn)
                else:
                    orch.assistant_audio_stopped()
        if turn is not None:
            turn.mark("speak_total", round(_time.time() - t0, 3))
            log.info("turn %s done: %s", turn.turn_id, self._turn_trace_line(turn))
        log.info(
            "stage speak first=%s total=%.2fs greeting=%s turn=%s",
            f"{t_first - t0:.2f}s" if t_first else "none",
            _time.time() - t0,
            is_greeting,
            turn.turn_id if turn else "-",
        )

    def _turn_trace_line(self, turn: Turn) -> str:
        """One line per turn: the timings that explain every latency question."""

        def gap(start: str, end: str) -> float:
            a, b = turn.metrics.get(start), turn.metrics.get(end)
            if a is None or b is None:
                return 0.0
            return round(b - a, 2)

        return (
            f"speech={gap('speech_start', 'speech_end')}s "
            f"stt+llm={gap('accepted', 'llm_done')}s "
            f"tts={gap('assistant_text', 'speak_total')}s "
            f"turn={gap('speech_start', 'turn_complete')}s "
            f"turns={self.orch.stats['turns'] if self.orch else 0} "
            f"rejected={self.orch.stats['rejected'] if self.orch else 0} "
            f"stale={self.orch.stats['stale_discarded'] if self.orch else 0} "
            f"transcript={turn.transcript[:44]!r}"
        )

    async def _auto_greet(self, text: str) -> None:
        try:
            if self.turn_active:
                return
            await self._speak(text, is_greeting=True)
        except Exception:  # noqa: BLE001 - greeting is best-effort
            log.exception("auto greeting failed")

    async def _finalise_utterance(self) -> None:
        """Close the open utterance and hand it to the worker, with its turn."""
        if self.orch is not None:
            self.orch.end_speech()
        if not self.vad.in_speech and self.vad.speech_ms <= 0:
            return
        # Read the buffer BEFORE take() resets it, otherwise the final transcript
        # is only the last partial and the answer is cut mid-sentence.
        buffered = self.vad.peek()
        pcm = self.vad.take()
        if not pcm or self.pipeline is None:
            return
        await self._drain_draft()
        turn = self.orch.turns.current if self.orch else None
        await self._stt_final(buffered)
        await self.enqueue("audio-draft" if self.hypothesis else "audio", pcm, turn)

    async def _turn_watchdog(self) -> None:
        """Finalise a turn when the audio stream stops before the VAD sees silence.

        A browser that pauses its microphone, a dropped socket or a caller who
        simply stops talking must not leave the turn hanging forever.
        """
        stale = float(os.getenv("STALE_UTTERANCE_S", "0.7"))
        while True:
            await asyncio.sleep(0.12)
            try:
                if not self.started or self.speaking:
                    continue
                if not self.vad.in_speech:
                    continue
                if __import__("time").time() - self._last_frame_at < stale:
                    continue
                log.info("no audio for %.1fs: finalising the open turn", stale)
                await self._finalise_utterance()
            except Exception:  # noqa: BLE001 - never kill the session
                log.exception("turn watchdog failed")

    async def _flush_interruption(self) -> None:
        """Transcribe and queue what the caller said while we were speaking."""
        if self.vad.speech_ms <= 0:
            self.vad.reset()
            return
        buffered = self.vad.peek()
        pcm = self.vad.take()
        if not pcm or self.pipeline is None:
            return
        await self._drain_draft()
        turn = self.orch.turns.current if self.orch else None
        await self._stt_final(buffered)
        await self.enqueue("audio-draft" if self.hypothesis else "audio", pcm, turn)

    async def _turn_worker(self) -> None:
        """One worker, one turn at a time. Every utterance is validated first."""
        while True:
            item = await self.queue.get()
            kind, payload, turn = item if len(item) == 3 else (item[0], item[1], None)
            self.turn_active = True
            self.last_activity = __import__("time").time()
            orch = self.orch
            if turn is not None and orch is not None and not orch.turns.is_live(turn):
                # A confirmed interruption cancelled this one before we got to it.
                self.turn_active = False
                continue
            # Interruption resets the flag only for the turn that owns it.
            self.interrupted = bool(turn is not None and turn.cancelled.is_set())
            try:
                assert self.pipeline is not None
                if turn is not None:
                    self.interrupted = False

                async def on_transcript(text: str) -> None:
                    if turn is not None and orch is not None and not orch.turns.is_live(turn):
                        return
                    await self.send_json(
                        {"type": "user", "text": text, "turnId": turn.turn_id if turn else None}
                    )
                    await self._send_backchannel(text, turn)

                # A previous turn's playback can finish after this turn started and
                # reset the shared state; make sure this turn can still proceed.
                if orch is not None and turn is not None and orch.turns.current is turn:
                    orch.reclaim_for(turn)
                # ---- validate before the model is allowed to run ----
                if kind == "text":
                    transcript = str(payload or "").strip()
                else:
                    transcript = self.hypothesis if kind == "audio-draft" else ""
                    if not transcript and turn is None:
                        # No turn owner (legacy path): transcribe here so the
                        # utterance is still understood rather than dropped.
                        try:
                            transcript = await self.pipeline.transcribe(payload)
                        except Exception:  # noqa: BLE001
                            log.exception("late stt failed")
                    self.hypothesis = ""
                log.info(
                    "worker turn=%s kind=%s transcript=%r",
                    turn.turn_id if turn else "-",
                    kind,
                    (transcript or "")[:60],
                )
                if turn is not None and orch is not None:
                    accepted, reason = orch.on_final(transcript or "", revision=turn.revision)
                    if not accepted:
                        log.info("turn %s rejected: %s", turn.turn_id, reason)
                        self.turn_active = False
                        continue
                if kind == "text":
                    answer = await self._complete_turn_text(transcript, on_transcript, turn)
                else:
                    answer = await self._complete_turn_audio(
                        payload, on_transcript, turn, hypothesis=transcript
                    )
                if not answer:
                    self.turn_active = False
                    continue
                if turn is not None and orch is not None and not orch.turns.is_live(turn):
                    self.turn_active = False
                    continue
                await self.send_json(
                    {"type": "assistant", "text": answer, "turnId": turn.turn_id if turn else None}
                )
                if turn is not None:
                    turn.mark("assistant_text")
                await self._speak(answer, turn=turn)
                if turn is not None:
                    turn.mark("turn_complete")
                    log.info("TURN %s %s", turn.turn_id, self._turn_trace_line(turn))
            except asyncio.CancelledError:  # pragma: no cover - cooperative cancel
                raise
            except Exception as exc:  # noqa: BLE001 - surface to client
                log.exception("turn failed")
                if self.orch is not None:
                    self.orch.error("turn_failed", message=str(exc))
                await self.send_json({"type": "error", "reason": "turn_failed", "message": str(exc)})
            finally:
                self.turn_active = False

    async def _complete_turn_text(self, text: str, on_transcript, turn: Turn | None) -> str:
        orch = self.orch
        assert self.pipeline is not None
        if orch is not None and turn is not None:
            await on_transcript(text)
            self.pipeline.state.add("user", text)
            answer = await orch.run_conversation(turn)
            self.pipeline.state.add("assistant", answer)
            return answer
        return await self.pipeline.handle_text(text, on_transcript=on_transcript)

    async def _complete_turn_audio(
        self, pcm: bytes, on_transcript, turn: Turn | None, hypothesis: str = ""
    ) -> str:
        orch = self.orch
        assert self.pipeline is not None
        # The validated transcript is authoritative; audio is only a fallback for
        # clients that do not send text.
        if hypothesis:
            await on_transcript(hypothesis)
            self.pipeline.state.add("user", hypothesis)
            if orch is not None and turn is not None:
                answer = await orch.run_conversation(turn)
                self.pipeline.state.add("assistant", answer)
                return answer
        return await self.pipeline.handle_audio(pcm, on_transcript=on_transcript, hypothesis=hypothesis)

    async def _stt_final(self, buffered: bytes) -> str:
        """Transcribe the complete utterance.

        A tail chunk on its own carries no context, so whisper drops or garbles
        the last words ("...about the enterprise plan instead" -> "...about the
        enterprise"). Accuracy is worth the extra pass.
        """
        if not buffered or self.pipeline is None:
            return self.hypothesis
        self._stt_consumed = len(buffered)
        text = ""
        try:
            text = await self.pipeline.transcribe(buffered)
        except Exception:  # noqa: BLE001 - keep the stitched hypothesis
            log.debug("final stt failed", exc_info=True)
        if text:
            self._hyp_parts = [text]
            self.hypothesis = text.strip()
            if len(self.hypothesis.split()) >= 3:
                await self.send_json({"type": "partial", "text": self.hypothesis})
        return self.hypothesis

    async def _stt_delta(self, final: bool = False) -> str:
        """Transcribe only the audio since the last delta and stitch the pieces.

        Deltas of ~0.7s keep partials and the speculative draft cheap; the final
        transcript comes from _stt_final on the whole utterance.
        """
        if self.pipeline is None:
            return ""
        buffered = self.vad.peek()
        start = self._stt_consumed
        if len(buffered) <= start:
            return self.hypothesis
        chunk = buffered[start:]
        if len(chunk) < STT_CHUNK_BYTES:
            return self.hypothesis
        self._stt_consumed = len(buffered)
        text = ""
        try:
            text = await self.pipeline.transcribe(chunk)
        except Exception:  # noqa: BLE001 - partials are best-effort
            log.debug("delta stt failed", exc_info=True)
        if text:
            self._hyp_parts.append(text)
            self.hypothesis = " ".join(self._hyp_parts).strip()
            if len(self.hypothesis.split()) >= 3:
                await self.send_json({"type": "partial", "text": self.hypothesis})
                self.start_draft(self.hypothesis)
        return self.hypothesis

    async def _drain_draft(self) -> None:
        """Wait for the speculative work so the real turn can be served from cache.

        Without this the draft and the real turn call the model at the same time:
        both get slower and neither benefits. The draft has had a head start of over
        a second, so the remaining wait is usually short.
        """
        task = self._draft_task
        if task is not None and not task.done():
            try:
                await task
            except Exception:  # noqa: BLE001 - drafting is best-effort
                log.debug("draft task failed", exc_info=True)
        self._draft_task = None
        api_task = self._draft_api_task
        if api_task is not None and not api_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(api_task), timeout=DRAFT_JOIN_TIMEOUT)
            except Exception:  # noqa: BLE001 - never block the turn on a draft
                log.debug("draft api join skipped")
        self._draft_api_task = None

    async def draft_text(self, text: str) -> None:
        """Warm the answer for a partial transcript without speaking or persisting."""
        assert self.pipeline is not None
        try:
            await self.pipeline.handle_text(text, draft=True)
        except Exception:  # noqa: BLE001 - drafting is best-effort
            log.debug("draft failed", exc_info=True)

    def start_draft(self, text: str) -> None:
        """Kick off model warming for a draft and remember it for the endpoint join."""
        if self._draft_api_task is None or self._draft_api_task.done():
            self._draft_api_task = asyncio.create_task(self.draft_text(text))

    async def _send_backchannel(self, text: str = "", turn: Turn | None = None) -> None:
        """Pre-cached acknowledgement so the caller never hears dead air.

        The client holds it for ~300ms and drops it if the real answer arrives
        first, so fast turns stay clean and slow turns get instant feedback.
        Never used for a greeting or a one-word acknowledgement: answering
        "hello" with "Got it." sounds broken, and those turns answer fast anyway.
        """
        global _first_backchannel
        tts = _tts
        if tts is None or self.interrupted or not _wants_backchannel(text):
            return
        if turn is not None and self.orch is not None and not self.orch.turns.is_live(turn):
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
        if self.orch is not None:
            self.orch.bus.emit(EventType.BACKCHANNEL, turn.turn_id if turn else None, phrase=phrase)
        await self.send_json(
            {
                "type": "backchannel",
                "text": phrase,
                "sampleRate": chunk.sample_rate,
                "encoding": "pcm16le",
                "turnId": turn.turn_id if turn else None,
            }
        )
        data = chunk.pcm16
        for i in range(0, len(data), 16384):
            await self.send_bytes(data[i : i + 16384])

    async def enqueue(self, kind: str, payload, turn: Turn | None = None) -> None:
        """Queue one utterance for the worker, newest wins, owner travels with it.

        The legacy `interrupted` flag is only set for turn-less playback; a real
        turn is cancelled by the orchestrator once its speech is confirmed.
        """
        if self.turn_active or not self.queue.empty():
            if turn is None:
                self.interrupted = True
            if self.orch is not None:
                self.orch.note_queued_utterance(turn)
            if self.queue.full():
                try:
                    self.queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
        await self.queue.put((kind, payload, turn))

    async def enqueue_utterance(self, pcm: bytes) -> None:
        await self.enqueue("audio", pcm, self.orch.turns.current if self.orch else None)

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
                self.last_activity = __import__("time").time()
                self._last_frame_at = self.last_activity
                self.partial.extend(message)
                while len(self.partial) >= FRAME_BYTES:
                    frame = bytes(self.partial[:FRAME_BYTES])
                    del self.partial[:FRAME_BYTES]
                    if self.speaking:
                        # Our own voice is in the room. Ignore the echo onset, keep
                        # the rest, and only interrupt once the caller is loud and
                        # sustained. The kept audio is replayed into the VAD when we
                        # do interrupt, so no words are lost.
                        if self._barge_taken:
                            # Already interrupting: keep feeding the utterance so the
                            # rest of their sentence is captured once, whole.
                            self.vad.feed(frame)
                            continue
                        if self._echo_guard_frames > 0:
                            # Counted in audio time, not wall-clock, so bursty caller
                            # audio is never swallowed by the guard.
                            self._echo_guard_frames -= 1
                            self.vad.reset()
                            continue
                        self._interrupt_buf += frame
                        if len(self._interrupt_buf) > INTERRUPT_KEEP_BYTES:
                            del self._interrupt_buf[: len(self._interrupt_buf) - INTERRUPT_KEEP_BYTES]
                        event = self.vad.feed(frame)
                        if event == "speech_start":
                            self._echo_candidate = True
                        elif event == "endpoint":
                            # Speech that stopped on its own was bleed, not a caller.
                            self._echo_candidate = False
                            self._interrupt_buf.clear()
                            self.vad.reset()
                        elif self._echo_candidate and self.vad.sustained():
                            self._echo_candidate = False
                            self._barge_taken = True
                            self.interrupted = True
                            if self.orch is not None:
                                # The caller now owns a turn: open it here so the
                                # words spoken over our audio have an owner and can
                                # never be answered as an unowned utterance.
                                self.orch.ensure_speech_turn()
                            # Replay the kept audio so the opening words survive.
                            self.vad.reset()
                            kept = bytes(self._interrupt_buf)
                            self._interrupt_buf.clear()
                            for i in range(0, len(kept), FRAME_BYTES):
                                self.vad.feed(kept[i : i + FRAME_BYTES])
                            if self.pipeline is not None:
                                self.pipeline.handle_barge_in()
                            await self.send_json({"type": "interrupted"})
                        continue
                    event = self.vad.feed(frame)
                    if event == "speech_start":
                        # Immediate UI feedback: the orb reacts while the caller is
                        # still speaking, not only after transcription finishes.
                        self._hyp_parts = []
                        self._stt_consumed = 0
                        self.hypothesis = ""
                        turn = self.orch.ensure_speech_turn() if self.orch else None
                        if turn is not None:
                            turn_id = turn.turn_id
                        else:
                            turn_id = None
                        await self.send_json({"type": "hearing", "turnId": turn_id})
                    elif event == "endpoint":
                        if self.orch is not None:
                            self.orch.end_speech()
                        await self._finalise_utterance()
                    else:
                        buffered = self.vad.peek()
                        if (
                            len(buffered) >= STT_DELTA_MIN_BYTES
                            and len(buffered) - self._stt_consumed >= STT_CHUNK_BYTES
                            and self._draft_task is None
                        ):
                            self._draft_task = asyncio.create_task(self._stt_delta(False))
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
                    draft = bool(msg.get("draft"))
                    if text and self.started and self.pipeline is not None:
                        if draft:
                            await self.draft_text(text)
                        else:
                            turn = self.orch.begin_speech() if self.orch else None
                            if self.orch is not None:
                                self.orch.end_speech()
                            await self.enqueue("text", text, turn)
                elif kind == "interrupt":
                    self.interrupted = True
                    if self.pipeline is not None:
                        self.pipeline.handle_barge_in()
                elif kind == "ping":
                    await self.send_json({"type": "pong"})

    async def _start_watchdog(self) -> None:
        if self.watchdog is None:
            self.watchdog = asyncio.create_task(self._watchdog())
        if self.turn_watchdog is None:
            self.turn_watchdog = asyncio.create_task(self._turn_watchdog())

    async def _watchdog(self) -> None:
        """Call guardrails: nudge on silence, hang up when it continues, cap length."""
        max_call = float(os.getenv("MAX_CALL_S", "600"))
        nudge_after = float(os.getenv("IDLE_NUDGE_S", "14"))
        hangup_after = float(os.getenv("IDLE_HANGUP_S", "32"))
        while True:
            await asyncio.sleep(2)
            try:
                if not self.started:
                    continue
                now = __import__("time").time()
                idle = now - self.last_activity
                if now - self.call_started > max_call:
                    await self._speak("Thanks for your time today. Goodbye!")
                    await asyncio.sleep(0.4)
                    await self.ws.close()
                    return
                if self.speaking or self.turn_active:
                    self.last_activity = now
                    continue
                if idle >= nudge_after and self.idle_nudges == 0:
                    self.idle_nudges = 1
                    self.last_activity = now
                    await self._speak("Are you still there?")
                elif idle >= hangup_after:
                    await self._speak("I did not hear anything, so I will let you go. Goodbye!")
                    await asyncio.sleep(0.4)
                    await self.ws.close()
                    return
            except Exception:  # noqa: BLE001 - watchdog must never kill the session
                log.exception("watchdog tick failed")

    async def close(self) -> None:
        if self.orch is not None:
            try:
                self.orch.end()
                log.info(
                    "voice trace session=%s turns=%s rejected=%s stale=%s interruptions=%s",
                    self.session_id,
                    self.orch.stats["turns"],
                    self.orch.stats["rejected"],
                    self.orch.stats["stale_discarded"],
                    self.orch.stats["interruptions"],
                )
            except Exception:  # noqa: BLE001 - teardown must not raise
                log.exception("orchestrator shutdown failed")
        if self.turn_watchdog:
            self.turn_watchdog.cancel()
        if self.watchdog:
            self.watchdog.cancel()
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
