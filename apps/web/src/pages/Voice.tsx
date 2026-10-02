import React from "react";
import { api, type AgentRow } from "../lib/api";
import { getWorkspace, getToken } from "../lib/session";
import { useToast } from "../main";

const WS_URL = (
  import.meta.env.VITE_VOICE_WS_URL ?? "wss://voice-runtime-production-dc24.up.railway.app"
).replace(/\/$/, "");

type Status = "idle" | "connecting" | "live" | "error";
type VoiceState = "idle" | "listening" | "thinking" | "speaking";

interface Line {
  id: number;
  role: "user" | "assistant" | "system";
  text: string;
}

export function VoicePage() {
  const toast = useToast();
  const [status, setStatus] = React.useState<Status>("idle");
  const [voiceState, setVoiceState] = React.useState<VoiceState>("idle");
  const [lines, setLines] = React.useState<Line[]>([]);
  const [agents, setAgents] = React.useState<AgentRow[]>([]);
  const [agentId, setAgentId] = React.useState<string>("");
  const [elapsed, setElapsed] = React.useState(0);

  const wsRef = React.useRef<WebSocket | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const micCtxRef = React.useRef<AudioContext | null>(null);
  const micNodeRef = React.useRef<ScriptProcessorNode | null>(null);
  const playCtxRef = React.useRef<AudioContext | null>(null);
  const chunksRef = React.useRef<Uint8Array[]>([]);
  const rateRef = React.useRef<number | null>(null);
  const pingRef = React.useRef<number | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const lineIdRef = React.useRef(1);
  const recogRef = React.useRef<any>(null);
  const recogWantedRef = React.useRef(false);
  const recogPausedRef = React.useRef(false);
  const recogActiveRef = React.useRef(false);
  const playNextRef = React.useRef<number | null>(null);
  const playNodesRef = React.useRef<AudioBufferSourceNode[]>([]);
  const playEndTimerRef = React.useRef<number | null>(null);

  const speechSupported =
    typeof window !== "undefined" &&
    Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  const active = status === "live" || status === "connecting";

  const pushLine = React.useCallback((role: Line["role"], text: string) => {
    setLines((prev) => [...prev, { id: lineIdRef.current++, role, text }].slice(-60));
  }, []);

  const setupRecognition = React.useCallback(
    (socket: WebSocket) => {
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SR) return;
      try {
        const rec = new SR();
        const lang = (agents.find((a) => a.id === agentId)?.language ?? "en").toLowerCase();
        rec.lang = lang.startsWith("hi") ? "hi-IN" : lang.startsWith("es") ? "es-ES" : lang.startsWith("ar") ? "ar-SA" : "en-US";
        rec.continuous = true;
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        rec.onresult = (ev: any) => {
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i];
            if (!r.isFinal) continue;
            const text = String(r[0]?.transcript ?? "").trim();
            if (text && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "text", text }));
            }
          }
        };
        rec.onerror = (ev: any) => {
          const err = String(ev?.error ?? "");
          if (err === "not-allowed" || err === "service-not-allowed") {
            pushLine("system", "browser speech blocked — falling back to server whisper");
            recogWantedRef.current = false;
            startMic(socket);
          } else if (err !== "no-speech" && err !== "aborted" && err !== "network") {
            pushLine("system", `speech recognition: ${err}`);
          }
        };
        rec.onend = () => {
          recogActiveRef.current = false;
          if (recogWantedRef.current && !recogPausedRef.current) {
            try {
              rec.start();
              recogActiveRef.current = true;
            } catch {
              /* next result cycle retries */
            }
          }
        };
        recogRef.current = rec;
      } catch (err) {
        pushLine("system", `speech recognition init failed: ${(err as Error).message}`);
      }
    },
    [pushLine],
  );

  const ensureRecog = React.useCallback(() => {
    if (!recogWantedRef.current || recogPausedRef.current || recogActiveRef.current || !recogRef.current) return;
    try {
      recogRef.current.start();
      recogActiveRef.current = true;
    } catch {
      /* already started */
    }
  }, []);

  const pauseRecog = React.useCallback(() => {
    recogPausedRef.current = true;
    if (recogActiveRef.current && recogRef.current) {
      try {
        recogRef.current.stop();
      } catch {
        /* noop */
      }
      recogActiveRef.current = false;
    }
  }, []);

  const resumeRecog = React.useCallback(() => {
    recogPausedRef.current = false;
    ensureRecog();
  }, [ensureRecog]);

  React.useEffect(() => {
    api.listAgents().then((r) => setAgents(r.items)).catch(() => undefined);
    return () => undefined;
  }, []);

  const teardown = React.useCallback(() => {
    recogWantedRef.current = false;
    recogPausedRef.current = false;
    recogActiveRef.current = false;
    try {
      recogRef.current?.stop();
    } catch {
      /* noop */
    }
    recogRef.current = null;
    if (pingRef.current) window.clearInterval(pingRef.current);
    if (timerRef.current) window.clearInterval(timerRef.current);
    pingRef.current = null;
    timerRef.current = null;
    try {
      wsRef.current?.close();
    } catch {
      /* noop */
    }
    wsRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try {
      micNodeRef.current?.disconnect();
      micCtxRef.current?.close();
    } catch {
      /* noop */
    }
    micNodeRef.current = null;
    micCtxRef.current = null;
    for (const n of playNodesRef.current) {
      try {
        n.onended = null;
        n.stop();
      } catch {
        /* noop */
      }
    }
    playNodesRef.current = [];
    playNextRef.current = null;
    if (playEndTimerRef.current) window.clearTimeout(playEndTimerRef.current);
    playEndTimerRef.current = null;
    try {
      playCtxRef.current?.close();
    } catch {
      /* noop */
    }
    playCtxRef.current = null;
    chunksRef.current = [];
    rateRef.current = null;
    setStatus("idle");
    setVoiceState("idle");
    setElapsed(0);
  }, []);

  React.useEffect(() => teardown, [teardown]);

  const stopPlayback = React.useCallback(() => {
    for (const n of playNodesRef.current) {
      try {
        n.onended = null;
        n.stop();
      } catch {
        /* noop */
      }
    }
    playNodesRef.current = [];
    playNextRef.current = null;
    if (playEndTimerRef.current) window.clearTimeout(playEndTimerRef.current);
    playEndTimerRef.current = null;
    chunksRef.current = [];
    rateRef.current = null;
    resumeRecog();
  }, [resumeRecog]);

  const finishPlayback = React.useCallback(() => {
    if (playEndTimerRef.current) window.clearTimeout(playEndTimerRef.current);
    playEndTimerRef.current = null;
    playNodesRef.current = [];
    playNextRef.current = null;
    chunksRef.current = [];
    rateRef.current = null;
    setVoiceState((s) => (s === "speaking" ? "listening" : s));
    resumeRecog();
  }, [resumeRecog]);

  const schedulePlayEnd = (ms: number) => {
    if (playEndTimerRef.current) window.clearTimeout(playEndTimerRef.current);
    playEndTimerRef.current = window.setTimeout(() => finishPlayback(), Math.max(50, ms));
  };

  /** Incremental playback: schedule complete 4096-sample blocks as bytes stream in
   *  (first audio paints before the whole reply is synthesized). */
  const flushAudio = (final: boolean) => {
    const rate = rateRef.current;
    if (!rate) return;
    const parts = chunksRef.current;
    const total = parts.reduce((s, p) => s + p.byteLength, 0);
    if (total < 2) return;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      merged.set(p, off);
      off += p.byteLength;
    }
    chunksRef.current = [];
    const blockSize = 8192; // 4096 samples @ any rate
    const processLen = final
      ? merged.byteLength - (merged.byteLength % 2)
      : Math.floor(merged.byteLength / blockSize) * blockSize;
    if (processLen === 0) {
      chunksRef.current = [merged];
      return;
    }
    const block = merged.subarray(0, processLen);
    const leftover = merged.subarray(processLen);
    if (leftover.byteLength) chunksRef.current = [new Uint8Array(leftover)];
    try {
      const ctx = playCtxRef.current ?? new AudioContext();
      playCtxRef.current = ctx;
      void ctx.resume();
      const pcm = new Int16Array(block.buffer, block.byteOffset, block.byteLength / 2);
      const buffer = ctx.createBuffer(1, pcm.length, rate);
      const ch = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      const now = ctx.currentTime;
      if (playNextRef.current == null || playNextRef.current < now) playNextRef.current = now + 0.05;
      node.start(playNextRef.current);
      playNextRef.current += buffer.duration;
      playNodesRef.current.push(node);
      if (final) schedulePlayEnd((playNextRef.current - ctx.currentTime) * 1000 + 150);
    } catch (err) {
      pushLine("system", `playback failed: ${(err as Error).message}`);
      finishPlayback();
    }
  };

  const start = async () => {
    const ws = getWorkspace();
    const token = getToken();
    if (!ws || !token) {
      toast({ kind: "err", text: "no session — sign in again" });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast({ kind: "err", text: "mic not supported in this browser" });
      return;
    }
    setStatus("connecting");
    pushLine("system", `connecting to ${WS_URL} …`);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      const socket = new WebSocket(WS_URL);
      socket.binaryType = "arraybuffer";
      wsRef.current = socket;
      if (speechSupported) setupRecognition(socket);

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: "start",
            token,
            workspaceId: ws.id,
            ...(agentId ? { agentId } : {}),
          }),
        );
        pingRef.current = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
        }, 25000);
      };

      socket.onerror = () => {
        pushLine("system", "websocket error — is the voice runtime up?");
      };

      socket.onclose = () => {
        if (wsRef.current === socket) teardown();
      };

      socket.onmessage = (ev) => {
        if (typeof ev.data !== "string") {
          const buf = ev.data as ArrayBuffer;
          if (rateRef.current != null) {
            chunksRef.current.push(new Uint8Array(buf));
            flushAudio(false);
          }
          return;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = msg.type as string;
        if (type === "ready") {
          setStatus("live");
          setVoiceState("listening");
          pushLine("system", `session ready · conversation ${(msg.conversationId as string)?.slice(0, 8)}…`);
          if (speechSupported && recogRef.current) {
            recogWantedRef.current = true;
            recogPausedRef.current = false;
            pushLine("system", "browser STT active — transcripts sent as text turns (~0.2s)");
            ensureRecog();
          } else {
            startMic(socket);
          }
          if (!timerRef.current) {
            const t0 = Date.now();
            timerRef.current = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
          }
        } else if (type === "user") {
          pushLine("user", msg.text as string);
          setVoiceState("thinking");
          if (rateRef.current != null) stopPlayback();
        } else if (type === "assistant") {
          pushLine("assistant", msg.text as string);
        } else if (type === "audio_start") {
          rateRef.current = Number(msg.sampleRate ?? 24000);
          chunksRef.current = [];
          playNextRef.current = null;
          if (playEndTimerRef.current) window.clearTimeout(playEndTimerRef.current);
          playEndTimerRef.current = null;
          setVoiceState("speaking");
          pauseRecog();
        } else if (type === "audio_end") {
          if (chunksRef.current.length === 0 && playNodesRef.current.length === 0) finishPlayback();
          else flushAudio(true);
        } else if (type === "pong") {
          /* keepalive */
        } else if (type === "error") {
          pushLine("system", `error: ${msg.reason ?? "unknown"}${msg.message ? ` — ${msg.message}` : ""}`);
          toast({ kind: "err", text: `voice: ${msg.reason ?? "error"}` });
        }
      };
    } catch (err) {
      pushLine("system", `mic/ws failed: ${(err as Error).message}`);
      toast({ kind: "err", text: (err as Error).message });
      teardown();
    }
  };

  const startMic = (socket: WebSocket) => {
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      micCtxRef.current = ctx;
      void ctx.resume();
      const src = ctx.createMediaStreamSource(streamRef.current!);
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (e) => {
        const f32 = e.inputBuffer.getChannelData(0);
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
          const s = Math.max(-1, Math.min(1, f32[i]));
          out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(out.buffer);
      };
      src.connect(proc);
      proc.connect(ctx.destination);
      micNodeRef.current = proc;
    } catch (err) {
      pushLine("system", `mic capture failed: ${(err as Error).message}`);
    }
  };

  const interrupt = () => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "interrupt" }));
    stopPlayback();
    setVoiceState("listening");
    resumeRecog();
    pushLine("system", "barge-in sent — agent stopped talking");
  };

  const toggle = () => {
    if (active) {
      teardown();
      pushLine("system", "call ended");
    } else {
      setLines([]);
      void start();
    }
  };

  const statusLabel: Record<Status, string> = {
    idle: "mic off — press the orb to start",
    connecting: "connecting to voice runtime…",
    live: `live · ${voiceState}`,
    error: "connection error",
  };

  return (
    <>
      <div className="page-head">
        <h2>Voice</h2>
        <p>
          Talk to your agent out loud. The browser transcribes your speech in ~0.2s (Web Speech API,
          server whisper as fallback) → Gemini answers → an American neural voice speaks. Tap
          Interrupt to barge in.
        </p>
      </div>

      <div className="split">
        <div className="card">
          <div className="voice-stage">
            <button
              className={`voice-orb${status === "connecting" ? " live" : ""}${voiceState === "speaking" ? " speaking" : ""}`}
              onClick={toggle}
              aria-label={active ? "End call" : "Start call"}
            >
              <i className={active ? "fa-solid fa-stop" : "fa-solid fa-microphone"} />
            </button>

            <div className={`voice-status ${status === "live" ? "on" : status === "connecting" ? "busy" : status === "error" ? "err" : ""}`}>
              <span className="dot" />
              {voiceState === "speaking" ? (
                <span className="voice-bars"><i /><i /><i /><i /></span>
              ) : null}
              {statusLabel[status]}
              {status === "live" && elapsed > 0 ? <span className="mono"> · {elapsed}s</span> : null}
            </div>

            <div className="voice-actions">
              {agents.length > 0 ? (
                <select
                  className="select"
                  style={{ maxWidth: 230 }}
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  disabled={active}
                >
                  <option value="">default agent</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              ) : null}
              <button className="btn btn-primary" onClick={toggle}>
                {active ? "End call" : "Start call"}
              </button>
              <button className="btn" onClick={interrupt} disabled={!active || voiceState !== "speaking"}>
                Interrupt
              </button>
            </div>

            <div className="voice-hints">
              <span className="pipe-step">headphones = cleanest barge-in</span>
              <span className="pipe-step">first reply ≈ 2–4s (speech → gemini → tts)</span>
              <span className="pipe-step">browser STT ≈ 0.2s · answers grounded in your knowledge</span>
            </div>

            <div className="voice-log">
              {lines.length === 0 ? (
                <div className="hint center">
                  Live transcript appears here — ask “how much is a premium styling?” after ingesting knowledge.
                </div>
              ) : (
                lines.map((l) => (
                  <div key={l.id} className={`voice-line ${l.role}`}>
                    <span className="who">
                      {l.role === "user" ? "you" : l.role === "assistant" ? "agent" : "system"}
                    </span>
                    <span className="said">{l.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title">How to test</div>
          <div className="trace">
            <div className="trace-item">
              <div className="k">1 · In-browser call</div>
              <div className="v">
                Press <strong>Start call</strong>, allow the mic, and speak — the browser transcribes
                you in ~0.2s and the agent replies out loud.{" "}
                <strong>Interrupt</strong> stops playback mid-sentence.
              </div>
            </div>
            <div className="trace-item">
              <div className="k">2 · Automated E2E</div>
              <div className="v mono">python scripts/_voice_e2e.py</div>
              <div className="hint">seeds a tenant, speaks WAV over the WS and asserts STT/LLM/TTS.</div>
            </div>
            <div className="trace-item">
              <div className="k">3 · Raw WebSocket</div>
              <div className="v mono">wss://voice-runtime-production-dc24.up.railway.app</div>
              <div className="hint">
                send {"{type:start, token, workspaceId}"} then either {"{type:text, text}"} turns or
                binary PCM16 @ 16 kHz; receive {" ready/user/assistant/audio_start"} + binary TTS
                {" (rate announced in audio_start)"}.
              </div>
            </div>
            <div className="trace-item">
              <div className="k">Pipeline</div>
              <div className="v">
                <span className="badge muted">web speech stt ~0.2s</span>{" "}
                <span className="badge muted">gemini-2.5-flash</span>{" "}
                <span className="badge muted">american neural tts</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
