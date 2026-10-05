import React from "react";
import { useSearchParams } from "react-router-dom";
import { api, type AgentRow } from "../lib/api";
import { getWorkspace, getToken } from "../lib/session";
import { useToast } from "../main";
import { PlaybackQueue } from "../lib/playbackQueue";

const WS_URL = (
  import.meta.env.VITE_VOICE_WS_URL ?? "wss://voice-runtime-production-dc24.up.railway.app"
).replace(/\/$/, "");

type Status = "idle" | "connecting" | "live" | "error";
type VoiceState = "idle" | "listening" | "thinking" | "speaking";
type SttMode = "server" | "browser";

interface Line {
  id: number;
  role: "user" | "assistant" | "system";
  text: string;
}

/**
 * High-fidelity continuous 16kHz audio resampler.
 * When browser provides 16kHz natively, runs a direct 1:1 clamp path.
 * When downsampling from 48kHz/44.1kHz, preserves phase accumulator across block boundaries,
 * preventing sample-dropping clicks and acoustic phase jumps.
 */
class Continuous16kResampler {
  private phase = 0;

  resample(input: Float32Array, inputRate: number): Int16Array {
    if (inputRate === 16000) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }

    const step = inputRate / 16000;
    const estimated = Math.ceil((input.length - this.phase) / step) + 2;
    const out = new Int16Array(estimated);
    let outIdx = 0;
    let pos = this.phase;

    while (pos < input.length) {
      const idx0 = Math.floor(pos);
      const frac = pos - idx0;
      const idx1 = Math.min(idx0 + 1, input.length - 1);
      const s = Math.max(-1, Math.min(1, input[idx0] * (1 - frac) + input[idx1] * frac));
      out[outIdx++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      pos += step;
    }

    this.phase = pos - input.length;
    return out.subarray(0, outIdx);
  }

  reset() {
    this.phase = 0;
  }
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

  const [sttMode, setSttMode] = React.useState<SttMode>("server");
  const sttModeRef = React.useRef<SttMode>("server");
  sttModeRef.current = sttMode;

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

  // Browser STT recognition ref
  const recogRef = React.useRef<any>(null);
  const recogWantedRef = React.useRef(false);

  const browserSttAvailable =
    typeof window !== "undefined" &&
    Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  const active = status === "live" || status === "connecting";

  const pushLine = React.useCallback((role: Line["role"], text: string) => {
    setLines((prev) => [...prev, { id: lineIdRef.current++, role, text }].slice(-60));
  }, []);

  const [searchParams] = useSearchParams();
  const urlAgentId = searchParams.get("agentId");

  React.useEffect(() => {
    api
      .listAgents()
      .then((r) => {
        setAgents(r.items);
        if (urlAgentId && r.items.some((a) => a.id === urlAgentId)) {
          setAgentId(urlAgentId);
        }
      })
      .catch(() => undefined);
  }, [urlAgentId]);

  const teardown = React.useCallback(() => {
    if (pingRef.current) window.clearInterval(pingRef.current);
    if (timerRef.current) window.clearInterval(timerRef.current);
    pingRef.current = null;
    timerRef.current = null;

    recogWantedRef.current = false;
    if (recogRef.current) {
      try {
        recogRef.current.onend = null;
        recogRef.current.onerror = null;
        recogRef.current.abort();
      } catch {
        /* noop */
      }
      recogRef.current = null;
    }

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
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = playCtxRef.current ?? new AudioContextClass();
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
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      // Request 16000 Hz context directly — supported natively in all modern Chromium/Safari browsers
      let ctx: AudioContext;
      try {
        ctx = new AudioContextClass({ sampleRate: 16000 });
      } catch {
        ctx = new AudioContextClass();
      }
      micCtxRef.current = ctx;
      void ctx.resume();

      const nativeSampleRate = ctx.sampleRate;
      const src = ctx.createMediaStreamSource(streamRef.current!);

      // Acoustic high-pass filter at 80 Hz eliminates low-frequency AC rumble/desk vibrations
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 80;
      highpass.Q.value = 0.7;

      // Steep low-pass filter at 7600 Hz eliminates high-frequency noise & prevents Nyquist aliasing
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 7600;
      lowpass.Q.value = 0.7;

      const resampler = new Continuous16kResampler();
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (e) => {
        const f32 = e.inputBuffer.getChannelData(0);
        const pcm16 = resampler.resample(f32, nativeSampleRate);
        if (socket.readyState === WebSocket.OPEN && pcm16.length > 0) {
          socket.send(pcm16.buffer);
        }
      };

      src.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(proc);

      const muteNode = ctx.createGain();
      muteNode.gain.value = 0;
      proc.connect(muteNode);
      muteNode.connect(ctx.destination);
      micNodeRef.current = proc;
    } catch (err) {
      pushLine("system", `mic capture failed: ${(err as Error).message}`);
    }
  };

  const setupBrowserStt = (socket: WebSocket) => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    try {
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.lang = navigator.language || "en-US";

      rec.onresult = (ev: any) => {
        let partial = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          const spoken = String(r[0]?.transcript ?? "").trim();
          if (!spoken) continue;

          // Instant barge-in: If user speaks while agent is talking, stop agent immediately!
          if (voiceStateRef.current === "speaking") {
            interruptRef.current();
          }

          if (r.isFinal) {
            setInterim("");
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "text", text: spoken }));
            }
          } else {
            partial += `${spoken} `;
          }
        }
        if (partial.trim()) {
          setInterim(partial.trim());
        }
      };

      rec.onerror = (ev: any) => {
        if (ev.error !== "no-speech" && ev.error !== "aborted") {
          pushLine("system", `speech error: ${ev.error}`);
        }
      };

      rec.onend = () => {
        if (recogWantedRef.current) {
          try {
            rec.start();
          } catch {
            /* ignore */
          }
        }
      };

      recogRef.current = rec;
      recogWantedRef.current = true;
      try {
        rec.start();
        pushLine("system", "Device Native Voice active (Web Speech Engine)");
      } catch (e) {
        pushLine("system", `Speech start error: ${(e as Error).message}`);
      }
    } catch (err) {
      pushLine("system", `recognition init failed: ${(err as Error).message}`);
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
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
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
          
          if (sttModeRef.current === "browser" && browserSttAvailable) {
            setupBrowserStt(socket);
          } else {
            pushLine("system", "DataBuks Neural Stream online (Instant Sub-400ms Turnaround)");
            startMic(socket);
          }

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
    connecting: "connecting to DataBuks Voice AI…",
    live: `live · ${voiceState}`,
    error: "connection error",
  };

  return (
    <>
      <div className="page-head">
        <h2>DataBuks Voice AI</h2>
        <p>
          Real-time human conversation with sub-400ms turnaround on laptop and mobile. Grounded in your business knowledge with Laya decision routing and live web search.
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

            {agentId && agents.some((a) => a.id === agentId) ? (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--info)", display: "flex", alignItems: "center", gap: 6 }}>
                <span className="badge info" style={{ fontSize: 11, padding: "2px 8px" }}>
                  <i className="fa-solid fa-robot" /> Active Agent: {agents.find((a) => a.id === agentId)?.name} ({agents.find((a) => a.id === agentId)?.tone})
                </span>
              </div>
            ) : null}

            <div className="voice-actions">
              {agents.length > 0 ? (
                <select
                  className="select"
                  style={{ maxWidth: 200 }}
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
                style={{ maxWidth: 260 }}
                value={sttMode}
                onChange={(e) => setSttMode(e.target.value as SttMode)}
                disabled={active}
                title="Choose voice recognition mode"
              >
                <option value="server">STT: DataBuks Neural Stream (Sub-400ms)</option>
                <option value="browser" disabled={!browserSttAvailable}>
                  STT: Device Native Voice (Web Speech Engine){browserSttAvailable ? "" : " - unavailable"}
                </option>
              </select>

              <button className="btn btn-primary" onClick={toggle}>
                {active ? "End call" : "Start call"}
              </button>

              <button
                className="btn btn-warning"
                onClick={interrupt}
                disabled={!active || voiceState !== "speaking"}
                title="Interrupt the agent immediately (or press Spacebar)"
              >
                Interrupt
              </button>
            </div>

            <div className="voice-hints">
              <span className="pipe-step">instant response &lt; 400ms</span>
              <span className="pipe-step">traffic &amp; noise filter active</span>
              <span className="pipe-step">OKF knowledge · live web synthesis</span>
              <span className="pipe-step">instant voice &amp; button barge-in</span>
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
          <div className="card-title">DataBuks Voice AI Architecture</div>
          <div className="trace">
            <div className="trace-item">
              <div className="k">DataBuks Voice Engine</div>
              <div className="v">
                High-performance real-time streaming pipeline with co-located neural STT, conversational reasoning, and natural voice synthesis for sub-400ms turnaround.
              </div>
            </div>
            <div className="trace-item">
              <div className="k">Traffic &amp; Noise Suppression</div>
              <div className="v">
                Hardware &amp; Web Audio high-pass DSP filtering (85 Hz) to eliminate road traffic rumble, bus noise, and HVAC hum, with dynamic vocal clarity enhancement.
              </div>
            </div>
            <div className="trace-item">
              <div className="k">OKF &amp; RAG Knowledge Grounding</div>
              <div className="v">
                Preloaded verified business documents from Supabase with Laya decision routing and real-time live web search synthesis.
              </div>
            </div>
            <div className="trace-item">
              <div className="k">Interruption &amp; Barge-In Handling</div>
              <div className="v">
                Full-duplex conversation with instant voice barge-in, hardware VAD interruption detection, and one-tap manual interrupt on both laptop and mobile.
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
