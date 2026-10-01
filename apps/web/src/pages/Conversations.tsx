import React from "react";
import { api, type ConversationRow, type MessageRow, type TurnTrace } from "../lib/api";
import { useToast } from "../main";

export function ConversationsPage() {
  const toast = useToast();
  const [convos, setConvos] = React.useState<ConversationRow[]>([]);
  const [active, setActive] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<MessageRow[]>([]);
  const [trace, setTrace] = React.useState<TurnTrace | null>(null);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const loadConvos = React.useCallback(() => {
    api
      .listConversations()
      .then((r) => {
        setConvos(r.items);
        if (!active && r.items.length) setActive(r.items[0]?.id ?? null);
      })
      .catch((e) => toast({ kind: "err", text: e.message }));
  }, [toast, active]);

  React.useEffect(loadConvos, [loadConvos]);

  React.useEffect(() => {
    if (!active) {
      setMessages([]);
      return;
    }
    api
      .messages(active)
      .then((r) => setMessages(r.items))
      .catch((e) => toast({ kind: "err", text: e.message }));
  }, [active, toast]);

  const newConversation = async () => {
    try {
      const c = await api.createConversation();
      setConvos((prev) => [c, ...prev]);
      setActive(c.id);
      setTrace(null);
    } catch (err) {
      toast({ kind: "err", text: (err as Error).message });
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!active || !input.trim()) return;
    setBusy(true);
    const text = input.trim();
    setInput("");
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: "user", content: text, citations: [], createdAt: new Date().toISOString() }]);
    try {
      const turn = await api.send(active, text);
      setTrace(turn);
      setMessages((m) => [
        ...m.filter((x) => !x.id.startsWith("tmp-")),
        turn.userMessage,
        turn.answer,
      ]);
    } catch (err) {
      toast({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Conversations</h2>
        <p>Live turn pipeline: decision → pgvector retrieval → context → LLM → harness verdict → persist.</p>
      </div>

      <div className="split">
        <div className="card">
          <div className="section-row">
            <div className="card-title" style={{ margin: 0 }}>
              Console {active ? <span className="mono muted"> · {active.slice(0, 8)}…</span> : null}
            </div>
            <button className="btn btn-primary btn-sm" onClick={newConversation}>+ New conversation</button>
          </div>

          {convos.length === 0 ? (
            <div className="empty">
              <strong>No conversations yet</strong>
              Start one to watch the grounded-answer pipeline run live.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {convos.slice(0, 8).map((c) => (
                  <button
                    key={c.id}
                    className={`btn btn-sm ${active === c.id ? "btn-primary" : ""}`}
                    onClick={() => { setActive(c.id); setTrace(null); }}
                  >
                    {c.id.slice(0, 6)}
                  </button>
                ))}
              </div>

              <div className="chat" style={{ minHeight: 220 }}>
                {messages.length === 0 ? (
                  <div className="hint">Say something — try “how much is a haircut?” after ingesting knowledge.</div>
                ) : (
                  messages.map((m) => (
                    <div key={m.id} className={`msg ${m.role}`}>
                      <div className="avatar">{m.role === "user" ? "U" : "AI"}</div>
                      <div>
                        <div className="bubble">{m.content}</div>
                        <div className="msg-meta">
                          <span>{new Date(m.createdAt).toLocaleTimeString()}</span>
                          {m.citations?.length ? <span className="badge ok">cited {m.citations.length} chunk{m.citations.length > 1 ? "s" : ""}</span> : null}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <form className="composer" onSubmit={send}>
                <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask the agent…" disabled={busy} />
                <button className="btn btn-primary" disabled={busy || !input.trim()}>
                  {busy ? <span className="spinner" /> : "Send"}
                </button>
              </form>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-title">Turn trace</div>
          {!trace ? (
            <div className="hint">Send a message to inspect the pipeline decision, retrieval scores and harness verdict.</div>
          ) : (
            <div className="trace">
              <div className="trace-item">
                <div className="k">Decision</div>
                <div className="v">
                  <span className="badge">{trace.decision.route}</span>{" "}
                  <span className="muted">conf {trace.decision.confidence.toFixed(2)}</span>
                  <div className="hint">{trace.decision.reason}</div>
                </div>
              </div>
              <div className="trace-item">
                <div className="k">Retrieval ({trace.retrieved.length} hits)</div>
                <div className="v">
                  {trace.retrieved.length === 0 ? (
                    <span className="hint">no matches — fallback path</span>
                  ) : (
                    trace.retrieved.map((r) => (
                      <div key={r.id} style={{ marginBottom: 6 }}>
                        <div className="score-bar">
                          <span className="badge info">{r.score.toFixed(3)}</span>
                          <span className="score-track"><span className="score-fill" style={{ width: `${Math.max(0, Math.min(1, r.score)) * 100}%` }} /></span>
                        </div>
                        <div className="hint">{r.text}…</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="trace-item">
                <div className="k">Harness verdict</div>
                <div className="v">
                  <span className={`badge ${trace.verdict.ok ? "ok" : "danger"}`}>{trace.verdict.ok ? "grounded · passed" : "fallback applied"}</span>{" "}
                  <span className="muted">confidence {trace.verdict.confidence.toFixed(2)}</span>
                  {trace.verdict.issues.length ? <div className="hint">{trace.verdict.issues.join(" · ")}</div> : null}
                </div>
              </div>
              <div className="trace-item">
                <div className="k">Answer source</div>
                <div className="v"><span className="badge info">{trace.answerSource}</span></div>
              </div>
              <div className="trace-item">
                <div className="k">Context budget</div>
                <div className="v mono">
                  {trace.context.usedTokens} tokens · {trace.context.includedChunkIds.length} chunks
                  {trace.context.truncated ? " · truncated" : ""}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
