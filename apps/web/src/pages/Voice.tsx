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
  const playSrcRef = React.useRef<AudioBufferSourceNode | null>(null);
  const chunksRef = React.useRef<Uint8Array[]>([]);
  const rateRef = React.useRef<number | null>(null);
  const pingRef = React.useRef<number | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const lineIdRef = React.useRef(1);

  const active = status === "live" || status === "connecting";

  const pushLine = React.useCallback((role: Line["role"], text: string) => {
    setLines((prev) => [...prev, { id: lineIdRef.current++, role, text }].slice(-60));
  }, []);

  React.useEffect(() => {
    api.listAgents().then((r) => setAgents(r.items)).catch(() => undefined);
    return () => undefined;
  }, []);

  const teardown = React.useCallback(() => {
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
    try {
      playSrcRef.current?.stop();
    } catch {
      /* noop */
    }
    playSrcRef.current = null;
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
    try {
      if (playSrcRef.current) {
        playSrcRef.current.onended = null;
        playSrcRef.current.stop();
      }
    } catch {
      /* noop */
    }
    playSrcRef.current = null;
    chunksRef.current = [];
    rateRef.current = null;
  }, []);

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
          if (rateRef.current != null) chunksRef.current.push(new Uint8Array(buf));
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
          startMic(socket);
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
          rateRef.current = Number(msg.sampleRate ?? 22050);
          chunksRef.current = [];
          setVoiceState("speaking");
        } else if (type === "audio_end") {
          playChunks();
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

  const playChunks = () => {
    const rate = rateRef.current;
    const parts = chunksRef.current;
    rateRef.current = null;
    chunksRef.current = [];
    if (!rate || parts.length === 0) {
      setVoiceState("listening");
      return;
    }
    const total = parts.reduce((s, p) => s + p.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      merged.set(p, off);
      off += p.byteLength;
    }
    try {
      const ctx = playCtxRef.current ?? new AudioContext();
      playCtxRef.current = ctx;
      void ctx.resume();
      const pcm = new Int16Array(merged.buffer, merged.byteOffset, merged.byteLength / 2);
      const buffer = ctx.createBuffer(1, pcm.length, rate);
      const ch = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
      stopPlaybackSrcOnly();
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.onended = () => {
        if (playSrcRef.current === node) {
          playSrcRef.current = null;
          setVoiceState((s) => (s === "speaking" ? "listening" : s));
        }
      };
      playSrcRef.current = node;
      node.start();
    } catch (err) {
      pushLine("system", `playback failed: ${(err as Error).message}`);
      setVoiceState("listening");
    }
  };

  const stopPlaybackSrcOnly = () => {
    try {
      if (playSrcRef.current) {
        playSrcRef.current.onended = null;
        playSrcRef.current.stop();
      }
    } catch {
      /* noop */
    }
    playSrcRef.current = null;
  };

  const interrupt = () => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "interrupt" }));
    stopPlayback();
    setVoiceState("listening");
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
          Talk to your agent out loud. Mic streams 16 kHz PCM over WebSocket → whisper transcribes →
          pgvector RAG answers → piper speaks. Interrupt anytime — just talk over it.
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
              <span className="pipe-step">first reply ≈ 5–9s (STT + grounded turn + TTS)</span>
              <span className="pipe-step">answers grounded in your knowledge</span>
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
                Press <strong>Start call</strong>, allow the mic, and speak. VAD detects your utterance,
                whisper transcribes it, and the RAG turn plays back through piper.{" "}
                <strong>Interrupt</strong> (or just talk over) stops playback.
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
                send {"{type:start, token, workspaceId}"} then binary PCM16 @ 16 kHz; receive
                {" ready/user/assistant/audio_start"} + binary TTS @ 22.05 kHz.
              </div>
            </div>
            <div className="trace-item">
              <div className="k">Pipeline</div>
              <div className="v">
                <span className="badge muted">mic 16k pcm</span>{" "}
                <span className="badge muted">energy vad</span>{" "}
                <span className="badge muted">whisper</span>{" "}
                <span className="badge muted">gemini-2.5-flash</span>{" "}
                <span className="badge muted">sentence tts</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
