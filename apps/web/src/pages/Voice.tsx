import React from "react";
import { api, type AgentRow } from "../lib/api";
import { getWorkspace, getToken } from "../lib/session";
import { useToast } from "../main";
import { PlaybackQueue } from "../lib/playbackQueue";

const WS_URL = (
  import.meta.env.VITE_VOICE_WS_URL ?? "wss://voice-runtime-production-dc24.up.railway.app"
).replace(/\/$/, "");

type Status = "idle" | "connecting" | "live" | "error";
type VoiceState = "idle" | "listening" | "thinking" | "speaking";
type EchoMode = "speaker" | "headset";

interface Line {
  id: number;
  role: "user" | "assistant" | "system";
  text: string;
}

export function VoicePage() {
  const toast = useToast();
  const [status, setStatus] = React.useState<Status>("idle");
  const [voiceState, _setVoiceState] = React.useState<VoiceState>("idle");
  const voiceStateRef = React.useRef<VoiceState>("idle");
  const setVoiceState = React.useCallback((val: React.SetStateAction<VoiceState>) => {
    _setVoiceState((prev) => {
      const next = typeof val === "function" ? val(prev) : val;
      voiceStateRef.current = next;
      return next;
    });
  }, []);

  const [echoMode, _setEchoMode] = React.useState<EchoMode>("speaker");
  const echoModeRef = React.useRef<EchoMode>("speaker");
  const setEchoMode = React.useCallback((mode: EchoMode) => {
    _setEchoMode(mode);
    echoModeRef.current = mode;
  }, []);

  const interruptRef = React.useRef<() => void>(() => {});
  const [lines, setLines] = React.useState<Line[]>([]);
  const [agents, setAgents] = React.useState<AgentRow[]>([]);
  const [agentId, setAgentId] = React.useState<string>("");
  const [elapsed, setElapsed] = React.useState(0);
  const [interim, setInterim] = React.useState("");

  // Ordered assistant audio queue (2048 bytes = 42ms block size for ultra-low latency onset)
  const playbackQueueRef = React.useRef(new PlaybackQueue(2048));
  const audioSeqRef = React.useRef(0);
  const playTurnRef = React.useRef<string | null>(null);

  const wsRef = React.useRef<WebSocket | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const micCtxRef = React.useRef<AudioContext | null>(null);
  const micNodeRef = React.useRef<ScriptProcessorNode | null>(null);
  const playCtxRef = React.useRef<AudioContext | null>(null);
  const rateRef = React.useRef<number | null>(null);
  const pingRef = React.useRef<number | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const lineIdRef = React.useRef(1);
  const playNextRef = React.useRef<number | null>(null);
  const playNodesRef = React.useRef<AudioBufferSourceNode[]>([]);
  const playEndTimerRef = React.useRef<number | null>(null);

  const active = status === "live" || status === "connecting";

  const pushLine = React.useCallback((role: Line["role"], text: string) => {
    setLines((prev) => [...prev, { id: lineIdRef.current++, role, text }].slice(-60));
  }, []);

  React.useEffect(() => {
    api.listAgents().then((r) => setAgents(r.items)).catch(() => undefined);
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
    rateRef.current = null;
    setStatus("idle");
    setVoiceState("idle");
    setElapsed(0);
    setInterim("");
  }, [setVoiceState]);

  React.useEffect(() => teardown, [teardown]);

  const stopPlayback = React.useCallback((reason = "flush") => {
    playTurnRef.current = null;
    const dropped = playbackQueueRef.current.flush();
    if (dropped > 0) pushLine("system", `audio queue flushed (${reason}): ${dropped} bytes dropped`);
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
    rateRef.current = null;
    setVoiceState((s) => (s === "speaking" ? "listening" : s));
  }, [pushLine, setVoiceState]);

  const interrupt = React.useCallback(() => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "interrupt" }));
    }
    stopPlayback("interrupted");
    setVoiceState("listening");
    pushLine("system", "barge-in: caller interrupted agent");
  }, [stopPlayback, pushLine, setVoiceState]);

  React.useEffect(() => {
    interruptRef.current = interrupt;
  }, [interrupt]);

  // Spacebar keyboard shortcut for instant barge-in
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && voiceStateRef.current === "speaking" && active) {
        e.preventDefault();
        interruptRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const finishPlayback = React.useCallback(() => {
    if (playEndTimerRef.current) window.clearTimeout(playEndTimerRef.current);
    playEndTimerRef.current = null;
    playNodesRef.current = [];
    playNextRef.current = null;
    rateRef.current = null;
    setVoiceState((s) => (s === "speaking" ? "listening" : s));
  }, [setVoiceState]);

  const schedulePlayEnd = (ms: number) => {
    if (playEndTimerRef.current) window.clearTimeout(playEndTimerRef.current);
    playEndTimerRef.current = window.setTimeout(() => finishPlayback(), Math.max(50, ms));
  };

  const scheduleAudio = (final: boolean) => {
    const blocks = playbackQueueRef.current.drain(final);
    for (const { pcm, rate } of blocks) {
      try {
        const ctx = playCtxRef.current ?? new AudioContext();
        playCtxRef.current = ctx;
        void ctx.resume();
        const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
        const buffer = ctx.createBuffer(1, samples.length, rate);
        const ch = buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        const now = ctx.currentTime;
        if (playNextRef.current == null || playNextRef.current < now) playNextRef.current = now + 0.01;
        node.start(playNextRef.current);
        playNextRef.current += buffer.duration;
        playNodesRef.current.push(node);
        if (final) schedulePlayEnd((playNextRef.current - ctx.currentTime) * 1000 + 100);
      } catch (err) {
        pushLine("system", `playback failed: ${(err as Error).message}`);
        finishPlayback();
      }
    }
  };

  const startMic = (socket: WebSocket) => {
    try {
      const ctx = new AudioContext({ sampleRate: 16000 });
      micCtxRef.current = ctx;
      void ctx.resume();
      const src = ctx.createMediaStreamSource(streamRef.current!);
      const proc = ctx.createScriptProcessor(1024, 1, 1);
      proc.onaudioprocess = (e) => {
        // Acoustic Echo Shield:
        // In Speakerphone mode, while the agent is speaking, drop microphone audio.
        // This physically prevents laptop speaker output from being heard by Deepgram,
        // completely eliminating the self-echo loop.
        if (voiceStateRef.current === "speaking" && echoModeRef.current === "speaker") {
          return;
        }

        const f32 = e.inputBuffer.getChannelData(0);
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
          const s = Math.max(-1, Math.min(1, f32[i]));
          out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        if (socket.readyState === WebSocket.OPEN) {
          socket.send(out.buffer);
        }
      };
      src.connect(proc);
      const muteNode = ctx.createGain();
      muteNode.gain.value = 0;
      proc.connect(muteNode);
      muteNode.connect(ctx.destination);
      micNodeRef.current = proc;
    } catch (err) {
      pushLine("system", `mic capture failed: ${(err as Error).message}`);
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
          if (playbackQueueRef.current.sampleRate > 0) {
            if (playbackQueueRef.current.push(playTurnRef.current, audioSeqRef.current++, buf)) {
              scheduleAudio(false);
            }
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
        if (type === "hearing") {
          setInterim("");
          setVoiceState((prev) => (prev === "listening" ? "thinking" : prev));
        } else if (type === "ready") {
          setStatus("live");
          setVoiceState("listening");
          pushLine("system", `session ready · conversation ${(msg.conversationId as string)?.slice(0, 8)}…`);
          pushLine("system", "Deepgram Voice Agent active (Flux STT + GPT-4.1-mini + Hannah TTS)");
          startMic(socket);
          if (!timerRef.current) {
            const t0 = Date.now();
            timerRef.current = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
          }
        } else if (type === "user") {
          setInterim("");
          pushLine("user", msg.text as string);
          setVoiceState("thinking");
        } else if (type === "assistant") {
          pushLine("assistant", msg.text as string);
        } else if (type === "interrupted") {
          stopPlayback("interrupted");
          setVoiceState("listening");
          pushLine("system", "barge-in: caller interrupted agent");
        } else if (type === "audio_start") {
          playTurnRef.current = (msg.turnId as string | undefined) ?? null;
          audioSeqRef.current = 0;
          playbackQueueRef.current.reset(Number(msg.sampleRate ?? 24000), playTurnRef.current);
          rateRef.current = Number(msg.sampleRate ?? 24000);
          playNextRef.current = null;
          if (playEndTimerRef.current) window.clearTimeout(playEndTimerRef.current);
          playEndTimerRef.current = null;
          setVoiceState("speaking");
        } else if (type === "audio_end") {
          scheduleAudio(true);
          if (playbackQueueRef.current.pendingBytes() === 0 && playNodesRef.current.length === 0) {
            finishPlayback();
          }
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
    connecting: "connecting to Deepgram Voice Agent…",
    live: `live · ${voiceState}`,
    error: "connection error",
  };

  return (
    <>
      <div className="page-head">
        <h2>Voice</h2>
        <p>
          Real-time human conversation with sub-400ms turnaround. Powered directly by Deepgram Voice Agent API
          (Flux STT, GPT-4.1-mini, Flux-Hannah neural voice).
        </p>
      </div>

      <div className="split">
        <div className="card">
          <div className="voice-stage">
            <button
              className={`voice-orb${status === "connecting" ? " live" : ""}${voiceState === "speaking" ? " speaking" : ""}`}
              onClick={voiceState === "speaking" ? interrupt : toggle}
              aria-label={active ? (voiceState === "speaking" ? "Interrupt" : "End call") : "Start call"}
              title={voiceState === "speaking" ? "Click orb to interrupt agent" : active ? "End call" : "Start call"}
            >
              <i className={voiceState === "speaking" ? "fa-solid fa-hand" : active ? "fa-solid fa-stop" : "fa-solid fa-microphone"} />
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
                  style={{ maxWidth: 220 }}
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

              <select
                className="select"
                style={{ maxWidth: 230 }}
                value={echoMode}
                onChange={(e) => setEchoMode(e.target.value as EchoMode)}
                title="Speakerphone: Shields mic during speech to prevent feedback loop on laptop speakers. Headset: Full-duplex continuous stream."
              >
                <option value="speaker">Speakerphone (Echo Shield)</option>
                <option value="headset">Headset (Full-Duplex)</option>
              </select>

              <button className="btn btn-primary" onClick={toggle}>
                {active ? "End call" : "Start call"}
              </button>

              <button
                className="btn btn-warning"
                onClick={interrupt}
                disabled={!active || voiceState !== "speaking"}
                title="Interrupt the agent (or press Spacebar)"
              >
                Interrupt (Space)
              </button>
            </div>

            <div className="voice-hints">
              <span className="pipe-step">instant response &lt; 400ms</span>
              <span className="pipe-step">zero echo feedback</span>
              <span className="pipe-step">verified knowledge · live web search</span>
            </div>

            <div className="voice-log">
              {lines.length === 0 ? (
                <div className="hint center">
                  Live conversation appears here — speak into your microphone to chat with the voice agent.
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
              {interim ? (
                <div className="voice-line user">
                  <span className="who">you</span>
                  <span className="said">
                    {interim}
                    <span className="muted"> …</span>
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Real-Time Voice Architecture</div>
          <div className="trace">
            <div className="trace-item">
              <div className="k">Deepgram Voice Agent API</div>
              <div className="v">
                Direct WebSocket connection to <strong>wss://agent.deepgram.com/v1/agent/converse</strong> with co-located STT, LLM, and TTS for ultra-low latency (&lt;400ms turnaround).
              </div>
            </div>
            <div className="trace-item">
              <div className="k">Acoustic Echo Shield</div>
              <div className="v">
                <strong>Speakerphone Mode:</strong> Shields mic while assistant speaks, eliminating acoustic loopback on laptop speakers.
                <br />
                <strong>Headset Mode:</strong> Continuous full-duplex streaming with hardware-level VAD barge-in.
              </div>
            </div>
            <div className="trace-item">
              <div className="k">Grounded Knowledge & Tools</div>
              <div className="v">
                Preloaded verified business chunks from Supabase, dynamic document search, real-time Google web search, and booking calendar integration.
              </div>
            </div>
            <div className="trace-item">
              <div className="k">Models Active</div>
              <div className="v">
                <span className="badge muted">STT: flux-general-en</span>{" "}
                <span className="badge muted">LLM: gpt-4.1-mini (&lt;350ms TTFT)</span>{" "}
                <span className="badge muted">TTS: flux-hannah-en</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
