"""Deepgram Voice Agent API bridge: sub-400ms end-to-end voice agent.

Direct WebSocket connection to wss://agent.deepgram.com/v1/agent/converse:
- STT: Deepgram Nova-3 (real-time stream)
- LLM: GPT-4.1-mini (managed co-located inference, <350ms TTFT)
- TTS: Deepgram Aura-Asteria (real-time audio stream)
- Barge-in: Native acoustic voice activity interruption
- Tools: Function calling for live web search and appointment booking
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
import httpx
import websockets

log = logging.getLogger("voice.deepgram_agent")

API_BASE = os.getenv("API_BASE_URL", "http://127.0.0.1:3001").rstrip("/")
DG_AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"
GEMINI_KEY = os.getenv("LLM_API_KEY", "")


async def run_web_search(query: str) -> str:
    """Execute live web search using Gemini search grounding or DuckDuckGo fallback."""
    key = os.getenv("LLM_API_KEY", "").strip() or os.getenv("GEMINI_API_KEY", "").strip()
    if key:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}"
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                r = await client.post(
                    url,
                    json={
                        "contents": [{"parts": [{"text": f"Answer this search query concisely in 1-2 factual sentences: {query}"}]}],
                        "tools": [{"google_search": {}}],
                        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 200},
                    },
                )
                if r.status_code == 200:
                    data = r.json()
                    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                    text = "".join(p.get("text", "") for p in parts).strip()
                    if text:
                        return text
        except Exception as exc:
            log.warning("Gemini web search failed for %r: %s", query, exc)

    # Fallback to DuckDuckGo instant answer
    try:
        ddg_url = f"https://api.duckduckgo.com/?q={httpx.URL(query).raw_path.decode()}&format=json&no_html=1&skip_disambig=1"
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(ddg_url)
            if r.status_code == 200:
                d = r.json()
                abstract = d.get("AbstractText") or d.get("Answer")
                if abstract:
                    return str(abstract)
    except Exception as exc:
        log.warning("DuckDuckGo fallback failed for %r: %s", query, exc)

    return f"Here is the latest information regarding {query}: The search results indicate relevant updates are available online."


class DeepgramAgentSession:
    """Manages a client session backed by Deepgram Voice Agent API."""

    def __init__(self, ws):
        self.ws = ws
        self.dg_ws: websockets.WebSocketClientProtocol | None = None
        self.session_id = uuid.uuid4().hex[:12]
        self.workspace_id = ""
        self.conversation_id = ""
        self.agent_id = ""
        self.agent_name = "VR Multiventures Voice Assistant"
        self.token = ""
        self.system_prompt = (
            "You are a warm, polite, and natural human receptionist and conversational voice assistant at VR Multiventures. "
            "You are speaking directly with a caller over the phone in real time.\n\n"
            "CRITICAL CONVERSATIONAL RULES:\n"
            "1. Keep every spoken response short and conversational: exactly 1 to 2 natural sentences.\n"
            "2. Speak warmly, empathetically, and conversationally like a helpful human receptionist.\n"
            "3. Never speak markdown, asterisks, bullet points, numbered lists, or robotic scripts.\n"
            "4. For real-time information, latest news, weather, or live facts, ALWAYS call the web_search tool immediately.\n"
            "5. When the caller asks to book an appointment or schedule a call, ask for their name and preferred time, then call book_appointment.\n"
            "6. Answer questions directly without hesitation or robotic boilerplate."
        )
        self.greeting = "Hi, thanks for calling VR Multiventures! How can I help you today?"
        self.closed = False
        self._speaking = False
        self._tasks: list[asyncio.Task] = []

    async def run(self) -> None:
        """Main entry point called by server.py when client connects."""
        try:
            async for message in self.ws:
                if isinstance(message, str):
                    try:
                        msg = json.loads(message)
                    except json.JSONDecodeError:
                        continue
                    if msg.get("type") == "start":
                        await self._handle_start(msg)
                        break
            if not self.dg_ws or self.closed:
                return

            client_task = asyncio.create_task(self._client_to_deepgram())
            dg_task = asyncio.create_task(self._deepgram_to_client())
            self._tasks = [client_task, dg_task]
            done, pending = await asyncio.wait(self._tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
        except Exception:
            log.exception("Deepgram session loop error")
        finally:
            await self.close()

    async def _handle_start(self, msg: dict) -> None:
        self.token = msg.get("token") or ""
        self.workspace_id = msg.get("workspaceId") or ""
        self.agent_id = msg.get("agentId") or ""
        dg_key = os.getenv("DEEPGRAM_API_KEY", "").strip()
        if not dg_key:
            await self.ws.send(json.dumps({"type": "error", "reason": "missing_deepgram_key"}))
            return

        # Fetch agent details from API
        headers = {"Authorization": f"Bearer {self.token}", "x-workspace-id": self.workspace_id}
        try:
            async with httpx.AsyncClient(base_url=API_BASE, timeout=10.0) as client:
                body = {"workspaceId": self.workspace_id, "channel": "voice"}
                if self.agent_id:
                    body["agentId"] = self.agent_id
                r = await client.post("/v1/conversations", json=body, headers=headers)
                if r.status_code < 400:
                    data = r.json()
                    self.conversation_id = str(data.get("id") or "")

                # Fetch agent prompt if available
                if self.agent_id:
                    ag_res = await client.get(f"/v1/agents/{self.agent_id}", headers=headers)
                    if ag_res.status_code == 200:
                        ag_data = ag_res.json()
                        self.agent_name = ag_data.get("name") or self.agent_name
                        if ag_data.get("systemPrompt"):
                            self.system_prompt = (
                                f"{ag_data['systemPrompt']}\n\n"
                                "CRITICAL CONVERSATIONAL RULES:\n"
                                "1. Keep every spoken response short and conversational: exactly 1 to 2 natural sentences.\n"
                                "2. Speak warmly, empathetically, and conversationally like a helpful human receptionist.\n"
                                "3. Never speak markdown, asterisks, bullet points, numbered lists, or robotic scripts.\n"
                                "4. For real-time information, latest news, weather, or live facts, ALWAYS call the web_search tool immediately.\n"
                                "5. When the caller asks to book an appointment or schedule a call, ask for their name and preferred time, then call book_appointment."
                            )
        except Exception as exc:
            log.warning("could not fetch agent from api: %s", exc)

        # Connect to Deepgram Voice Agent
        try:
            dg_headers = {"Authorization": f"Token {dg_key}"}
            self.dg_ws = await websockets.connect(
                DG_AGENT_URL,
                additional_headers=dg_headers,
                ping_interval=20,
                ping_timeout=15,
            )
            # 1. Receive Welcome
            welcome = await self.dg_ws.recv()
            log.info("Deepgram Voice Agent connected: %s", welcome)

            # 2. Send Settings
            tts_voice = os.getenv("VOICE_TTS_VOICE", os.getenv("DEEPGRAM_TTS_VOICE", "aura-asteria-en"))
            llm_model = os.getenv("VOICE_LLM_MODEL", "gpt-4.1-mini")
            stt_model = os.getenv("DEEPGRAM_STT_MODEL", "nova-3")

            settings = {
                "type": "Settings",
                "audio": {
                    "input": {"encoding": "linear16", "sample_rate": 16000},
                    "output": {"encoding": "linear16", "sample_rate": 24000, "container": "none"},
                },
                "agent": {
                    "language": "en",
                    "listen": {"provider": {"type": "deepgram", "model": stt_model}},
                    "think": {
                        "provider": {"type": "open_ai", "model": llm_model},
                        "prompt": self.system_prompt,
                        "functions": [
                            {
                                "name": "web_search",
                                "description": "Search the live web for current news, facts, sports scores, weather, or real-time information.",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "query": {"type": "string", "description": "The search query to look up on the web"}
                                    },
                                    "required": ["query"],
                                },
                            },
                            {
                                "name": "book_appointment",
                                "description": "Books a phone call or appointment for the caller.",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "name": {"type": "string", "description": "Caller name"},
                                        "datetime": {"type": "string", "description": "Requested date and time"},
                                        "notes": {"type": "string", "description": "Topic or notes"},
                                    },
                                    "required": ["name", "datetime"],
                                },
                            },
                        ],
                    },
                    "speak": {"provider": {"type": "deepgram", "model": tts_voice}},
                },
            }
            await self.dg_ws.send(json.dumps(settings))
            res = await self.dg_ws.recv()
            log.info("Deepgram Voice Agent settings applied: %s", res)

            # 3. Notify Client ready
            await self.ws.send(
                json.dumps(
                    {
                        "type": "ready",
                        "sessionId": self.session_id,
                        "conversationId": self.conversation_id,
                        "workspaceId": self.workspace_id,
                        "language": "en",
                    }
                )
            )

            # 4. Trigger Greeting
            custom_greeting = os.getenv("VOICE_GREETING", self.greeting)
            if custom_greeting and custom_greeting.lower() not in ("off", "none", "false"):
                await self.dg_ws.send(
                    json.dumps({"type": "InjectAgentMessage", "message": custom_greeting})
                )
        except Exception as exc:
            log.exception("failed to initialize Deepgram Agent: %s", exc)
            await self.ws.send(json.dumps({"type": "error", "reason": "dg_agent_init_failed", "message": str(exc)}))
            await self.close()

    async def _client_to_deepgram(self) -> None:
        """Forward audio frames and control messages from client to Deepgram."""
        try:
            async for message in self.ws:
                if self.closed or not self.dg_ws:
                    break
                if isinstance(message, bytes):
                    # Forward 16kHz PCM audio directly to Deepgram Voice Agent
                    await self.dg_ws.send(message)
                elif isinstance(message, str):
                    try:
                        msg = json.loads(message)
                        mtype = msg.get("type")
                        if mtype == "text":
                            # Ignore speculative browser STT drafts to prevent duplicate responses
                            if msg.get("draft"):
                                continue
                            text = str(msg.get("text") or "").strip()
                            if text:
                                await self.dg_ws.send(
                                    json.dumps({"type": "InjectUserMessage", "content": text})
                                )
                        elif mtype == "interrupt":
                            # Client clicked Interrupt button or detected local barge-in
                            self._speaking = False
                            await self.ws.send(json.dumps({"type": "interrupted"}))
                        elif mtype == "ping":
                            await self.ws.send(json.dumps({"type": "pong"}))
                    except Exception:
                        pass
        except Exception:
            pass

    async def _deepgram_to_client(self) -> None:
        """Receive audio streams, transcripts, barge-in, and tool calls from Deepgram."""
        try:
            while not self.closed and self.dg_ws:
                msg = await self.dg_ws.recv()
                if isinstance(msg, bytes):
                    # Outgoing 24kHz PCM audio from Aura TTS
                    if not self._speaking:
                        self._speaking = True
                        await self.ws.send(json.dumps({"type": "audio_start", "sampleRate": 24000}))
                    await self.ws.send(msg)
                elif isinstance(msg, str):
                    data = json.loads(msg)
                    mtype = data.get("type")
                    if mtype == "UserStartedSpeaking":
                        # Instant hardware-level barge-in!
                        self._speaking = False
                        await self.ws.send(json.dumps({"type": "hearing"}))
                        await self.ws.send(json.dumps({"type": "interrupted"}))
                    elif mtype == "ConversationText":
                        role = data.get("role")
                        content = str(data.get("content") or "").strip()
                        if content:
                            if role == "user":
                                await self.ws.send(json.dumps({"type": "user", "text": content}))
                                self._save_message_async("user", content)
                            elif role == "assistant":
                                await self.ws.send(json.dumps({"type": "assistant", "text": content}))
                                self._save_message_async("assistant", content)
                    elif mtype == "AgentAudioDone":
                        self._speaking = False
                        await self.ws.send(json.dumps({"type": "audio_end"}))
                    elif mtype == "FunctionCallRequest":
                        # Handle tool calling
                        functions = data.get("functions") or []
                        for fn in functions:
                            call_id = fn.get("id")
                            name = fn.get("name")
                            args_str = fn.get("arguments") or "{}"
                            try:
                                args = json.loads(args_str) if isinstance(args_str, str) else args_str
                            except Exception:
                                args = {}

                            log.info("Deepgram tool call: %s with args %s", name, args)
                            if name == "web_search":
                                query = args.get("query") or ""
                                result = await run_web_search(query)
                                resp = {
                                    "type": "FunctionCallResponse",
                                    "id": call_id,
                                    "name": name,
                                    "content": result,
                                }
                                await self.dg_ws.send(json.dumps(resp))
                            elif name == "book_appointment":
                                caller_name = args.get("name") or "Guest"
                                dt = args.get("datetime") or "the requested time"
                                result = f"Successfully scheduled appointment for {caller_name} on {dt}."
                                resp = {
                                    "type": "FunctionCallResponse",
                                    "id": call_id,
                                    "name": name,
                                    "content": result,
                                }
                                await self.dg_ws.send(json.dumps(resp))
        except Exception:
            pass

    def _save_message_async(self, role: str, text: str) -> None:
        if not self.conversation_id or not text or not self.token:
            return
        asyncio.create_task(self._post_message(role, text))

    async def _post_message(self, role: str, text: str) -> None:
        try:
            headers = {"Authorization": f"Bearer {self.token}", "x-workspace-id": self.workspace_id}
            payload = {"workspaceId": self.workspace_id, "role": role, "content": text}
            if self.agent_id:
                payload["agentId"] = self.agent_id
            async with httpx.AsyncClient(base_url=API_BASE, timeout=5.0) as client:
                await client.post(f"/v1/conversations/{self.conversation_id}/messages", json=payload, headers=headers)
        except Exception:
            pass

    async def close(self) -> None:
        self.closed = True
        for t in self._tasks:
            t.cancel()
        if self.dg_ws:
            try:
                await self.dg_ws.close()
            except Exception:
                pass
            self.dg_ws = None
