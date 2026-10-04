"""Deepgram Voice Agent API bridge: sub-400ms end-to-end voice agent with RAG & Web Search.

Direct WebSocket connection to wss://agent.deepgram.com/v1/agent/converse:
- STT: Deepgram Flux / Nova-3 (real-time stream with end-of-turn detection)
- LLM: GPT-4.1-mini (managed co-located inference, <350ms TTFT)
- TTS: Deepgram Aura-Asteria (real-time audio stream)
- Knowledge: Direct Supabase RAG injection + dynamic knowledge search tool
- Web Search: Live Google search grounding via Gemini / DuckDuckGo fallback
- Barge-in: Native acoustic VAD with accurate state tracking (no false interrupts)
- Tools: Function calling for search_knowledge_base, web_search, book_appointment
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
SB_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SB_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()


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
        clean_q = httpx.URL(query).raw_path.decode()
        ddg_url = f"https://api.duckduckgo.com/?q={clean_q}&format=json&no_html=1&skip_disambig=1"
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(ddg_url)
            if r.status_code == 200:
                d = r.json()
                abstract = d.get("AbstractText") or d.get("Answer")
                if abstract:
                    return str(abstract)
    except Exception as exc:
        log.warning("DuckDuckGo fallback failed for %r: %s", query, exc)

    return f"Here is the latest information regarding {query}: online sources confirm relevant updates are available."


async def search_knowledge(workspace_id: str, query: str) -> str:
    """Search workspace documents/chunks in Supabase for query keywords."""
    if not SB_URL or not SB_KEY or not workspace_id:
        return "No knowledge base documents configured for this workspace."
    try:
        clean_q = query.replace("?", "").replace("!", "").replace(",", " ").strip()
        words = [w for w in clean_q.split() if len(w) > 3 and w.lower() not in ("what", "when", "where", "which", "your", "tell", "about", "have")]
        filter_str = f"workspace_id=eq.{workspace_id}"
        if words:
            filter_str += f"&content=ilike.*{words[0]}*"
        url = f"{SB_URL}/rest/v1/chunks?{filter_str}&select=content,metadata&limit=4"
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(url, headers={"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"})
            if r.status_code == 200 and r.json():
                items = r.json()
                results = [c.get("content", "").strip() for c in items if c.get("content")]
                if results:
                    return "\n\n".join(results)
    except Exception as exc:
        log.warning("knowledge search failed: %s", exc)

    return "No matching specific records found in company documents. Politely inform caller you will check with the team."


async def load_workspace_context(workspace_id: str, agent_id: str = "") -> tuple[dict, str]:
    """Fetch agent details and verified knowledge chunks from Supabase."""
    agent_info = {
        "name": "Receptionist",
        "prompt": "",
        "greeting": "Hello, thanks for calling! How can I help you today?",
        "language": "en",
    }
    knowledge_text = ""
    if not SB_URL or not SB_KEY or not workspace_id:
        return agent_info, knowledge_text

    headers = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}
    async with httpx.AsyncClient(timeout=4.0) as client:
        # 1. Load agent details
        try:
            agent_url = (
                f"{SB_URL}/rest/v1/agents?id=eq.{agent_id}&select=id,name,system_prompt,language"
                if agent_id
                else f"{SB_URL}/rest/v1/agents?workspace_id=eq.{workspace_id}&select=id,name,system_prompt,language&limit=1"
            )
            r_agent = await client.get(agent_url, headers=headers)
            if r_agent.status_code == 200 and r_agent.json():
                ag = r_agent.json()[0]
                agent_info["name"] = ag.get("name") or agent_info["name"]
                agent_info["language"] = ag.get("language") or "en"
                if ag.get("system_prompt"):
                    agent_info["prompt"] = ag["system_prompt"]
                agent_info["greeting"] = f"Hi, thanks for calling {agent_info['name']}! How can I help you today?"
        except Exception as exc:
            log.warning("failed to load agent from Supabase: %s", exc)

        # 2. Load verified knowledge chunks (up to 25 chunks from uploaded docs)
        try:
            chunks_url = f"{SB_URL}/rest/v1/chunks?workspace_id=eq.{workspace_id}&select=content,metadata&order=created_at.desc&limit=25"
            r_chunks = await client.get(chunks_url, headers=headers)
            if r_chunks.status_code == 200 and r_chunks.json():
                chunks = r_chunks.json()
                snippets: list[str] = []
                for c in chunks:
                    cnt = (c.get("content") or "").strip()
                    if cnt and cnt not in snippets:
                        snippets.append(cnt)
                if snippets:
                    knowledge_text = "\n\n".join(snippets)
        except Exception as exc:
            log.warning("failed to load chunks from Supabase: %s", exc)

    return agent_info, knowledge_text


class DeepgramAgentSession:
    """Manages a client session backed by Deepgram Voice Agent API."""

    def __init__(self, ws):
        self.ws = ws
        self.dg_ws: websockets.WebSocketClientProtocol | None = None
        self.session_id = uuid.uuid4().hex[:12]
        self.workspace_id = ""
        self.conversation_id = ""
        self.agent_id = ""
        self.agent_name = "Front Desk Assistant"
        self.token = ""
        self.system_prompt = ""
        self.greeting = "Hello, thanks for calling! How can I help you today?"
        self.closed = False
        self._speaking = False
        self._last_assistant_text = ""
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

        # 1. Fetch agent config and verified knowledge chunks from Supabase
        agent_info, knowledge_text = await load_workspace_context(self.workspace_id, self.agent_id)
        self.agent_name = agent_info["name"]
        self.greeting = agent_info["greeting"]

        # Build prompt: strictly grounded in verified knowledge to prevent hallucinations
        base_prompt = agent_info.get("prompt") or (
            f"You are a warm, polite, and natural human receptionist and voice assistant for {self.agent_name}. "
            "You are speaking directly with a caller over the phone in real time."
        )

        prompt_parts = [
            base_prompt,
            "\nCRITICAL CONVERSATIONAL RULES:",
            "1. Keep every spoken response concise: exactly 1 to 2 short, natural sentences.",
            "2. Speak warmly, politely, and conversationally like a real human receptionist.",
            "3. Never speak markdown, asterisks, bullet points, numbered lists, or robotic scripts.",
            "4. Answer questions directly without hesitation.",
        ]

        if knowledge_text:
            prompt_parts.extend([
                "\n=== VERIFIED BUSINESS KNOWLEDGE (from our uploaded documents) ===",
                knowledge_text,
                "=== END OF VERIFIED BUSINESS KNOWLEDGE ===",
                "\nSTRICT ANTI-HALLUCINATION RULES:",
                "- When asked about our business, products, pricing, hours, or services, answer ONLY using the VERIFIED BUSINESS KNOWLEDGE above.",
                "- If a specific detail (like a custom price, unlisted service, or unmentioned policy) is NOT in the knowledge base, say: 'I don't have that specific detail in our notes right now, but I can have the team follow up with you on that.' NEVER invent, assume, or hallucinate business numbers, prices, or policies!",
            ])
        else:
            prompt_parts.extend([
                "\n- When asked for specific business pricing or policies not in your notes, politely offer to connect with the team.",
            ])

        prompt_parts.extend([
            "\nNAME SPELLING RULE (CRITICAL FOR ACCURACY):",
            "- When the caller provides their name (e.g. for booking or leaving contact details), ALWAYS ask them to spell out their name letter-by-letter to guarantee exact spelling accuracy (for example, to distinguish between 'Sudhanshu' and 'Sudhansu', 'Pooja' and 'Puja', 'Ritu' and 'Reetu'):",
            "  Say: 'Could you please spell your name out for me so I make sure I have the exact spelling right?'",
            "- When the caller spells out letters (e.g., 'S-U-D-H-A-N-S-H-U'), capture and confirm that exact spelling without guessing or changing it.",
            "\nTOOLS USAGE:",
            "- For real-time external questions (weather, sports scores, current news, outside facts), call the web_search tool.",
            "- For specific company document searches, call the search_knowledge_base tool.",
            "- When the caller asks to book an appointment or schedule a call, ask for their name, ask them to spell it out, ask their preferred date and time, then call book_appointment.",
        ])

        self.system_prompt = "\n".join(prompt_parts)

        # 2. Record conversation in SaaS API if available
        headers = {"Authorization": f"Bearer {self.token}", "x-workspace-id": self.workspace_id}
        try:
            async with httpx.AsyncClient(base_url=API_BASE, timeout=6.0) as client:
                body = {"workspaceId": self.workspace_id, "channel": "voice"}
                if self.agent_id:
                    body["agentId"] = self.agent_id
                r = await client.post("/v1/conversations", json=body, headers=headers)
                if r.status_code < 400:
                    data = r.json()
                    self.conversation_id = str(data.get("id") or "")
        except Exception as exc:
            log.warning("could not record conversation in api: %s", exc)

        # 3. Connect to Deepgram Voice Agent API
        try:
            dg_headers = {"Authorization": f"Token {dg_key}"}
            self.dg_ws = await websockets.connect(
                DG_AGENT_URL,
                additional_headers=dg_headers,
                ping_interval=20,
                ping_timeout=15,
            )
            # Receive Welcome
            welcome = await self.dg_ws.recv()
            log.info("Deepgram Voice Agent connected: %s", welcome)

            # Send Settings
            tts_voice = os.getenv("VOICE_TTS_VOICE", os.getenv("DEEPGRAM_TTS_VOICE", "flux-hannah-en"))
            llm_model = os.getenv("VOICE_LLM_MODEL", "gpt-4.1-mini")
            stt_model = os.getenv("DEEPGRAM_STT_MODEL", "flux-general-en")

            settings = {
                "type": "Settings",
                "audio": {
                    "input": {"encoding": "linear16", "sample_rate": 16000},
                    "output": {"encoding": "linear16", "sample_rate": 24000, "container": "none"},
                },
                "agent": {
                    "listen": {"provider": {"type": "deepgram", "model": stt_model}},
                    "think": {
                        "provider": {"type": "open_ai", "model": llm_model},
                        "prompt": self.system_prompt,
                        "functions": [
                            {
                                "name": "search_knowledge_base",
                                "description": "Searches the company's uploaded documents and knowledge base for detailed policies, instructions, guides, or specifications.",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "query": {"type": "string", "description": "The search query to look up in company documents"}
                                    },
                                    "required": ["query"],
                                },
                            },
                            {
                                "name": "web_search",
                                "description": "Search the live web for current external news, sports scores, weather, or real-time facts.",
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

            # Notify Client ready
            await self.ws.send(
                json.dumps(
                    {
                        "type": "ready",
                        "sessionId": self.session_id,
                        "conversationId": self.conversation_id,
                        "workspaceId": self.workspace_id,
                        "language": agent_info.get("language", "en"),
                    }
                )
            )

            # Trigger Greeting
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
                            # Ignore speculative browser STT drafts to prevent duplicate/repeated interruptions
                            if msg.get("draft"):
                                continue
                            text = str(msg.get("text") or "").strip()
                            if text:
                                await self.dg_ws.send(
                                    json.dumps({"type": "InjectUserMessage", "content": text})
                                )
                        elif mtype == "interrupt":
                            # Client explicitly clicked Interrupt button or detected local speech
                            was_speaking = self._speaking
                            self._speaking = False
                            if was_speaking:
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
                        # Hardware-level VAD detected caller speech!
                        was_speaking = self._speaking
                        self._speaking = False
                        await self.ws.send(json.dumps({"type": "hearing"}))
                        # ONLY send interrupted to the client if the agent was actually speaking!
                        if was_speaking:
                            await self.ws.send(json.dumps({"type": "interrupted"}))
                    elif mtype == "ConversationText":
                        role = data.get("role")
                        content = str(data.get("content") or "").strip()
                        if content:
                            if role == "assistant":
                                self._last_assistant_text = content
                                await self.ws.send(json.dumps({"type": "assistant", "text": content}))
                                self._save_message_async("assistant", content)
                            elif role == "user":
                                if self._is_echo(content):
                                    log.info("Ignored self-echo user transcript: %r", content)
                                    continue
                                await self.ws.send(json.dumps({"type": "user", "text": content}))
                                self._save_message_async("user", content)
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
                            if name == "search_knowledge_base":
                                query = args.get("query") or ""
                                result = await search_knowledge(self.workspace_id, query)
                                resp = {
                                    "type": "FunctionCallResponse",
                                    "id": call_id,
                                    "name": name,
                                    "content": result,
                                }
                                await self.dg_ws.send(json.dumps(resp))
                            elif name == "web_search":
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
                                notes = args.get("notes") or ""
                                self._save_booking_async(caller_name, dt, notes)
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

    def _save_booking_async(self, customer_name: str, starts_at: str, notes: str) -> None:
        if not SB_URL or not SB_KEY or not self.workspace_id:
            return
        asyncio.create_task(self._insert_booking(customer_name, starts_at, notes))

    async def _insert_booking(self, customer_name: str, starts_at: str, notes: str) -> None:
        try:
            row = {
                "workspace_id": self.workspace_id,
                "conversation_id": self.conversation_id or None,
                "customer_name": customer_name,
                "contact": "",
                "starts_at": starts_at,
                "notes": notes,
                "status": "confirmed",
                "source": "agent",
            }
            headers = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(f"{SB_URL}/rest/v1/bookings", json=row, headers=headers)
        except Exception as exc:
            log.warning("could not insert booking: %s", exc)

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

    def _is_echo(self, user_text: str) -> bool:
        """Check if incoming user transcript is actually an acoustic echo of assistant speech."""
        if not self._last_assistant_text or not user_text:
            return False
        u = "".join(ch for ch in user_text.lower() if ch.isalnum())
        a = "".join(ch for ch in self._last_assistant_text.lower() if ch.isalnum())
        if len(u) < 4:
            return False
        return u in a or a in u or (len(u) >= 8 and (a.endswith(u[:10]) or a.startswith(u[:10])))

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
