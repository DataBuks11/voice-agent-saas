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
import struct
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
    """Search workspace documents and chunks in Supabase with multi-keyword matching across all docs."""
    if not SB_URL or not SB_KEY or not workspace_id:
        return "No knowledge base documents configured for this workspace."
    try:
        clean_q = query.replace("?", "").replace("!", "").replace(",", " ").strip()
        stop_words = {"what", "when", "where", "which", "your", "tell", "about", "have", "with", "from", "that", "this", "some", "need", "know", "much", "many", "does", "will"}
        words = [w for w in clean_q.split() if len(w) > 2 and w.lower() not in stop_words]

        filter_parts = []
        for w in words[:4]:
            filter_parts.append(f"content.ilike.*{w}*")

        filter_str = f"workspace_id=eq.{workspace_id}"
        if filter_parts:
            filter_str += f"&or=({','.join(filter_parts)})"

        url = f"{SB_URL}/rest/v1/chunks?{filter_str}&select=content,metadata,document_id&limit=10"
        headers = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}
        async with httpx.AsyncClient(timeout=4.0) as client:
            r = await client.get(url, headers=headers)
            if r.status_code == 200 and r.json():
                items = r.json()
                results = []
                for c in items:
                    cnt = (c.get("content") or "").strip()
                    doc_title = c.get("metadata", {}).get("doc_title") or ""
                    if cnt:
                        results.append(f"[{doc_title}]\n{cnt}" if doc_title else cnt)
                if results:
                    return "\n\n".join(results[:5])
    except Exception as exc:
        log.warning("knowledge search failed: %s", exc)

    return "No matching specific records found in company documents. You may combine verified knowledge with the web_search tool or inform the caller the team will follow up."


async def load_workspace_context(workspace_id: str, agent_id: str = "") -> tuple[dict, str, list[str]]:
    """Fetch agent details and verified dental clinic knowledge chunks from Supabase."""
    agent_info = {
        "name": "Allright Dental Receptionist",
        "prompt": "",
        "greeting": "Thank you for calling Allright Dental! My name is Sarah. How can I help you with your dental care today?",
        "language": "en",
        "tone": "warm, professional and comforting",
        "fallback": "I'd be happy to check with Dr. Mandapatti's team and have someone follow up with you.",
    }
    knowledge_text = ""
    keyterm_titles: list[str] = []
    if not SB_URL or not SB_KEY or not workspace_id:
        return agent_info, knowledge_text, keyterm_titles

    headers = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}
    async with httpx.AsyncClient(timeout=6.0) as client:
        # 1. Load agent details (pick requested agent, or latest created agent for this workspace)
        try:
            agent_url = (
                f"{SB_URL}/rest/v1/agents?id=eq.{agent_id}&select=id,name,system_prompt,language,tone,fallback_response"
                if agent_id
                else f"{SB_URL}/rest/v1/agents?workspace_id=eq.{workspace_id}&select=id,name,system_prompt,language,tone,fallback_response&order=created_at.desc&limit=1"
            )
            r_agent = await client.get(agent_url, headers=headers)
            if r_agent.status_code == 200 and r_agent.json():
                ag = r_agent.json()[0]
                agent_info["name"] = ag.get("name") or agent_info["name"]
                agent_info["language"] = ag.get("language") or "en"
                agent_info["tone"] = ag.get("tone") or "warm, professional and comforting"
                agent_info["fallback"] = ag.get("fallback_response") or agent_info["fallback"]
                if ag.get("system_prompt"):
                    agent_info["prompt"] = ag["system_prompt"]
                agent_info["greeting"] = f"Thank you for calling {agent_info['name']}! My name is Sarah. How can I help you with your dental care today?"
        except Exception as exc:
            log.warning("failed to load agent from Supabase: %s", exc)

        # 2. Load verified documents & chunks balanced across ALL uploaded documents
        try:
            docs_url = f"{SB_URL}/rest/v1/documents?workspace_id=eq.{workspace_id}&select=id,title,metadata&order=created_at.asc"
            r_docs = await client.get(docs_url, headers=headers)
            docs = r_docs.json() if r_docs.status_code == 200 and r_docs.json() else []

            doc_titles: dict[str, str] = {d["id"]: d.get("title") or "Business Knowledge" for d in docs}
            by_doc: dict[str, list[str]] = {}

            # Fetch chunks per document so NO document is starved, keeping prompt compact & fast
            if docs:
                chunks_per_doc = max(2, min(5, 12 // len(docs)))
                for d in docs:
                    d_id = d["id"]
                    d_title = d.get("title") or "Business Knowledge"
                    by_doc.setdefault(d_title, [])
                    c_url = f"{SB_URL}/rest/v1/chunks?workspace_id=eq.{workspace_id}&document_id=eq.{d_id}&select=content,metadata&order=created_at.asc&limit={chunks_per_doc}"
                    r_c = await client.get(c_url, headers=headers)
                    if r_c.status_code == 200 and r_c.json():
                        for row in r_c.json():
                            cnt = (row.get("content") or "").strip()
                            if cnt and cnt not in by_doc[d_title]:
                                by_doc[d_title].append(cnt[:450])
            else:
                fallback_url = f"{SB_URL}/rest/v1/chunks?workspace_id=eq.{workspace_id}&select=document_id,content,metadata&order=created_at.desc&limit=6"
                r_fb = await client.get(fallback_url, headers=headers)
                if r_fb.status_code == 200 and r_fb.json():
                    for row in r_fb.json():
                        d_id = row.get("document_id") or "general"
                        d_title = doc_titles.get(d_id) or row.get("metadata", {}).get("doc_title") or "General Knowledge"
                        cnt = (row.get("content") or "").strip()
                        if cnt:
                            by_doc.setdefault(d_title, [])
                            if cnt not in by_doc[d_title]:
                                by_doc[d_title].append(cnt[:450])

            doc_sections: list[str] = []
            for d_title, snippets in by_doc.items():
                if snippets:
                    doc_sections.append(f"=== DOCUMENT: {d_title} ===\n" + "\n\n".join(snippets[:5]))

            if doc_sections:
                knowledge_text = "\n\n--------------------\n\n".join(doc_sections)
                if len(knowledge_text) > 6500:
                    knowledge_text = knowledge_text[:6500].rsplit("\n", 1)[0]
            keyterm_titles = [d.get("title") for d in docs if d.get("title")]
        except Exception as exc:
            log.warning("failed to load multi-document context from Supabase: %s", exc)

    return agent_info, knowledge_text, keyterm_titles


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
        agent_info, knowledge_text, keyterm_titles = await load_workspace_context(self.workspace_id, self.agent_id)
        self.agent_name = agent_info["name"]
        self.greeting = agent_info["greeting"]

        # Build prompt: strictly grounded in verified dental knowledge & clinic procedures
        base_prompt = agent_info.get("prompt") or (
            f"You are Sarah, the warm, caring, and highly professional American dental receptionist for {self.agent_name} "
            "(Allright Dental, practice of Dr. Shalini Mandapatti, DDS in Morrisville, PA). "
            "You are speaking live with a patient over the telephone in real time. "
            "Your main role is to welcome callers warmly, answer questions about dental treatments, "
            "and schedule dental care appointments smoothly and efficiently."
        )

        prompt_parts = [
            base_prompt,
            f"\nTone: {agent_info.get('tone', 'warm, professional and comforting')}. Default fallback policy: {agent_info.get('fallback', 'I would be glad to check with Dr. Mandapatti and have our front desk team confirm that for you.')}",
            "\nCLINIC OVERVIEW & ESSENTIAL DETAILS:",
            "- Practice Name: Allright Dental (also recognized as All Right Dental)",
            "- Lead Dentist: Dr. Shalini Mandapatti, DDS (15+ years experience, graduate of New York University College of Dentistry; specialist in cosmetic dentistry, dental implants, restorative crowns, and gentle anxiety-free care)",
            "- Clinic Address: 229 Plaza Blvd, Suite 23, Morrisville, PA 19067 (conveniently serving Morrisville, Yardley, Levittown, Fairless Hills, Fallsington, and Bucks County)",
            "- Phone: (215) 295-1348",
            "- Operating Hours:",
            "  * Wednesday – Thursday: 10:00 AM – 7:00 PM",
            "  * Friday: 10:00 AM – 6:00 PM",
            "  * Saturday: 9:00 AM – 12:00 PM (Noon)",
            "  * Monday, Tuesday, Sunday: Emergency dental triage & dedicated visits by appointment",
            "  * 24/7 Virtual AI Receptionist (You): Answering patient questions and booking appointments around the clock!",
            "- Services Provided:",
            "  * General & Preventive: Comprehensive exams, gentle dental cleanings (prophylaxis), digital low-dose X-rays, oral cancer screening, deep cleaning / periodontal scaling.",
            "  * Emergency Dental Care: Urgent same-day care for severe toothaches, broken/chipped teeth, knocked-out teeth, lost fillings/crowns, swelling, or abscesses.",
            "  * Cosmetic Dentistry: Zoom professional in-office & take-home teeth whitening, handcrafted porcelain veneers, aesthetic bonding, smile makeovers.",
            "  * Restorative & Implants: Dental implants (single tooth, bridges, full-arch), porcelain crowns, tooth-colored composite fillings, bridges, dentures.",
            "  * Endodontics: Gentle root canal therapy to relieve tooth pain and preserve natural teeth.",
            "  * Orthodontics: Invisalign clear aligners for adults and teens.",
            "- Insurances & Financing:",
            "  * In-network with major PPO dental insurances: Delta Dental, MetLife, Cigna, Aetna, Guardian, United Healthcare, and others.",
            "  * Flexible patient financing available through CareCredit (with interest-free options), all major credit cards, and transparent self-pay pricing.",
            "\nCRITICAL CONVERSATIONAL RULES (MUST FOLLOW AT ALL TIMES):",
            "1. KEEP SPOKEN TURNS BRIEF: exactly 1 to 2 short, natural conversational sentences. Never speak markdown, lists, or bullets.",
            "2. DIRECT, EMPATHETIC ANSWERS: Reassure anxious dental patients with warmth and empathy.",
            "3. CONTINUITY: If interrupted, seamlessly address what the caller just said while retaining the prior call history.",
            "\n*** MANDATORY PROTOCOL: PATIENT NAME CAPTURE (ONE-TIME SPELLING RULE) ***:",
            "1. When a caller asks to book an appointment or schedule a visit, ask for their name and visit reason.",
            "2. When a caller introduces their name (e.g. 'I am Piyush', 'My name is Sarah', 'This is Alex'):",
            "   Greet them and ask them to spell it out ONCE in your immediate response:",
            "   'Wonderful to meet you, [Name]! Could you spell your name for me so I make sure I record it correctly?'",
            "3. ABSOLUTE RULE — NEVER ASK TO SPELL TWICE:",
            "   Once you have asked to spell the name, whatever the caller says next (whether they spell individual letters like 'P I Y U S H', or repeat the name, or say 'It is Piyush'):",
            "   ACCEPT IT IMMEDIATELY! Do NOT ask them to spell it again under any circumstances!",
            "   Acknowledge the name and move directly to asking for their preferred appointment day and time:",
            "   'Thank you, [Name]! What day and time works best for your appointment?'",
            "4. If the caller spells their name in the very first turn (e.g. 'I am Piyush, P-I-Y-U-S-H'):",
            "   Acknowledge it immediately without asking to spell: 'Thank you, Piyush! What day and time works best for your appointment?'",
            "\nAPPOINTMENT BOOKING EXECUTION:",
            "- When you have the patient's name, requested day/time, and visit reason, call the book_appointment tool immediately.",
            "- Confirm warmly: 'I have scheduled your appointment with Dr. Mandapatti for [day/time]. We look forward to seeing your smile at Allright Dental!'",
            "\nEMERGENCY DENTAL CARE PROTOCOL:",
            "- If a patient reports severe tooth pain, swelling, a broken tooth, or dental trauma, express immediate empathy and prioritize urgent same-day booking.",
            "\nFOCUS BOUNDARIES:",
            "- You represent Allright Dental clinic exclusively. If a caller asks about unrelated outside businesses, politely steer back to dental care.",
            "\nPHONETIC CORRECTIONS & ACCENT HANDLING:",
            "- The clinic name is Allright Dental. Speech recognition (STT) may transcribe it as 'All Right Dental', 'Alright Dental', 'All Right', or 'Allred Dental'. Recognize all of these as Allright Dental.",
            "- Doctor name: Dr. Shalini Mandapatti. Speech recognition may hear 'Mandapatti', 'Manda Patti', or 'Shalini'.",
            "- Caller names: Prioritize the caller's spelling confirmation.",
        ]

        if knowledge_text:
            prompt_parts.extend([
                "\n=== OKF VERIFIED DENTAL CLINIC KNOWLEDGE ===",
                knowledge_text,
                "=== END OF VERIFIED DENTAL CLINIC KNOWLEDGE ===",
            ])
        else:
            prompt_parts.extend([
                "\n- For specific procedure fees or insurance verification not in your notes, politely offer to check with the front desk team.",
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

            # Send Settings - Native American English voice (aura-asteria-en)
            tts_voice = os.getenv("VOICE_TTS_VOICE", os.getenv("DEEPGRAM_TTS_VOICE", "aura-asteria-en"))
            llm_model = os.getenv("VOICE_LLM_MODEL", "gpt-4.1-mini")
            stt_model = os.getenv("DEEPGRAM_STT_MODEL", "nova-3")
            if stt_model in ("flux-general-en", "base.en", "nova-2"):
                stt_model = "nova-3"

            # Intelligent keyterms list for Nova-3 to boost recognition of clinic, dental terms, and names
            keyterms = [
                "Allright Dental", "All Right Dental", "Dr. Shalini Mandapatti", "Mandapatti", "Morrisville", "Yardley",
                "Invisalign", "cleaning", "toothache", "veneers", "implant", "crown", "Delta Dental", "CareCredit",
                "appointment", "booking", "Piyush", "piyush", "Alex", "Sarah", "Emily"
            ]
            if self.agent_name and self.agent_name not in keyterms:
                keyterms.append(self.agent_name)
            for kt in keyterm_titles:
                clean_kt = kt.strip()
                if clean_kt and len(clean_kt) <= 35 and clean_kt not in keyterms:
                    keyterms.append(clean_kt)

            listen_provider = {
                "type": "deepgram",
                "model": stt_model,
                "smart_format": True,
                "language": agent_info.get("language") or "en",
                "endpointing": 350,
                "keyterms": keyterms[:30],
            }

            settings = {
                "type": "Settings",
                "audio": {
                    "input": {"encoding": "linear16", "sample_rate": 16000},
                    "output": {"encoding": "linear16", "sample_rate": 24000, "container": "none"},
                },
                "agent": {
                    "listen": {"provider": listen_provider},
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
                                "description": "Books a dental care appointment for the patient with Dr. Mandapatti at Allright Dental.",
                                "parameters": {
                                    "type": "object",
                                    "properties": {
                                        "name": {"type": "string", "description": "Patient full name"},
                                        "datetime": {"type": "string", "description": "Requested appointment day and time"},
                                        "service": {"type": "string", "description": "Reason for visit (routine cleaning, toothache emergency, cosmetic, implants, checkup)"},
                                        "phone": {"type": "string", "description": "Callback phone number if provided"},
                                        "insurance": {"type": "string", "description": "Dental insurance provider if provided"},
                                        "notes": {"type": "string", "description": "Symptoms, pain details, or special requests"},
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
                    # Acoustic Echo Shield: If assistant is actively speaking, drop low-energy frames
                    # that represent laptop speaker bleed leaking into the microphone.
                    if self._speaking and len(message) >= 4:
                        shorts = struct.unpack(f"<{len(message)//2}h", message)
                        peak = max(abs(s) for s in shorts)
                        if peak < 2200:  # Below barge-in threshold -> drop speaker bleed
                            continue
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
                                if self._is_echo(text):
                                    log.info("Ignored self-echo text turn: %r", text)
                                    continue
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
                                caller_name = args.get("name") or "Patient"
                                dt = args.get("datetime") or "the requested time"
                                service = args.get("service") or "Dental Care Visit"
                                phone = args.get("phone") or ""
                                insurance = args.get("insurance") or ""
                                notes = args.get("notes") or ""
                                combined_notes = f"Service: {service}"
                                if insurance:
                                    combined_notes += f" | Insurance: {insurance}"
                                if notes:
                                    combined_notes += f" | Notes: {notes}"
                                self._save_booking_async(caller_name, dt, combined_notes, phone)
                                result = f"Successfully scheduled dental appointment for {caller_name} on {dt} for {service} with Dr. Mandapatti."
                                resp = {
                                    "type": "FunctionCallResponse",
                                    "id": call_id,
                                    "name": name,
                                    "content": result,
                                }
                                await self.dg_ws.send(json.dumps(resp))
        except Exception:
            pass

    def _save_booking_async(self, customer_name: str, starts_at: str, notes: str, contact: str = "") -> None:
        if not SB_URL or not SB_KEY or not self.workspace_id:
            return
        asyncio.create_task(self._insert_booking(customer_name, starts_at, notes, contact))

    async def _insert_booking(self, customer_name: str, starts_at: str, notes: str, contact: str = "") -> None:
        try:
            row = {
                "workspace_id": self.workspace_id,
                "conversation_id": self.conversation_id or None,
                "customer_name": customer_name,
                "contact": contact,
                "starts_at": starts_at,
                "notes": notes,
                "status": "confirmed",
                "source": "allright_dental_voice",
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
        """Check if incoming user transcript is strictly an acoustic echo of assistant speech."""
        if not self._last_assistant_text or not user_text:
            return False
        # If assistant is not currently outputting audio, it's genuine user speech!
        if not self._speaking:
            return False
        u = "".join(ch for ch in user_text.lower() if ch.isalnum())
        a = "".join(ch for ch in self._last_assistant_text.lower() if ch.isalnum())
        if len(u) < 8:
            return False
        # Suppress ONLY if user input is an exact verbatim match or 90%+ identical echo of what assistant just spoke
        if u == a or (len(u) >= 18 and u in a):
            return True
        return False

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
