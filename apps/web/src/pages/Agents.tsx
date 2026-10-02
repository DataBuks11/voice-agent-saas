import React from "react";
import { api, type AgentRow } from "../lib/api";
import { useToast } from "../main";

export function AgentsPage() {
  const toast = useToast();
  const [items, setItems] = React.useState<AgentRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [form, setForm] = React.useState({
    name: "",
    language: "en",
    tone: "professional",
    systemPrompt:
      "You are a professional American-English receptionist. Be warm, natural and concise. Only answer from provided knowledge.",
    fallbackResponse: "I don't have verified information about that yet.",
    location: "",
  });
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    api
      .listAgents()
      .then((r) => setItems(r.items))
      .catch((e) => toast({ kind: "err", text: e.message }))
      .finally(() => setLoading(false));
  }, [toast]);

  React.useEffect(load, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createAgent(form);
      toast({ kind: "ok", text: `Agent "${form.name}" created` });
      setForm({ ...form, name: "" });
      load();
    } catch (err) {
      toast({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h2>Agents</h2>
        <p>Tenant-scoped agent configs: language, tone, system prompt and fallback policy.</p>
      </div>

      <div className="split">
        <div className="card">
          <div className="card-title">Configured agents</div>
          {loading ? (
            <div className="center muted" style={{ padding: 24 }}><span className="spinner" /></div>
          ) : items.length === 0 ? (
            <div className="empty">
              <strong>No agents yet</strong>
              Create one — it becomes the voice/knowledge personality for this workspace.
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Language</th><th>Tone</th><th>Fallback</th></tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.name}</strong>
                      <div className="mono muted">{a.id.slice(0, 8)}…</div>
                    </td>
                    <td><span className="badge muted">{a.language}</span></td>
                    <td><span className="badge info">{a.tone}</span></td>
                    <td className="muted" style={{ maxWidth: 260 }}>{a.fallbackResponse}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <form className="card" onSubmit={create}>
          <div className="card-title">New agent</div>
          <div className="field">
            <label>Name</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Salon Receptionist" required />
          </div>
          <div className="field">
            <label>Language</label>
            <select className="select" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
              <option value="en">English (en)</option>
              <option value="en-IN">English · India (en-IN)</option>
              <option value="hi">Hindi (hi)</option>
              <option value="mr">Marathi (mr)</option>
              <option value="es">Spanish (es)</option>
            </select>
          </div>
          <div className="field">
            <label>Tone</label>
            <select className="select" value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })}>
              <option value="professional">professional</option>
              <option value="friendly">friendly</option>
              <option value="concise">concise</option>
              <option value="warm">warm</option>
            </select>
          </div>
          <div className="field">
            <label>System prompt</label>
            <textarea className="textarea" style={{ minHeight: 96 }} value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} />
          </div>
          <div className="field">
            <label>Fallback response</label>
            <input className="input" value={form.fallbackResponse} onChange={(e) => setForm({ ...form, fallbackResponse: e.target.value })} />
          </div>
          <div className="field">
            <label>Business address (powers Google Maps)</label>
            <input
              className="input"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              placeholder="123 Main St, Springfield, IL 62701"
            />
          </div>
          <button className="btn btn-primary" disabled={busy || !form.name.trim()} style={{ width: "100%" }}>
            {busy ? <span className="spinner" /> : "Create agent"}
          </button>
        </form>
      </div>
    </>
  );
}
